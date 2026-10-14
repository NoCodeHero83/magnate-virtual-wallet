-- Recuperar el PIN olvidado con un código enviado por email.
--
-- 1. request_pin_reset(email): si el email existe, envía un código de 6 dígitos (vence en 10 min).
--    Siempre responde lo mismo, para no revelar qué emails están registrados.
-- 2. confirm_pin_reset(email, código, PIN nuevo): valida el código (5 intentos), guarda el PIN,
--    desbloquea los intentos, cierra las sesiones abiertas y avisa por email.
--
-- Los límites de envío (1 por minuto, 5 por hora) los aplica _otp_issue.

CREATE OR REPLACE FUNCTION public.request_pin_reset(p_email text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user record;
  v_code text;
BEGIN
  SELECT id, email, verification_status INTO v_user
    FROM public.users
   WHERE lower(email) = lower(trim(COALESCE(p_email, '')));

  IF FOUND AND v_user.verification_status <> 'suspended' THEN
    BEGIN
      v_code := public._otp_issue('pin_reset', v_user.id, v_user.email, NULL);
      PERFORM public.enqueue_notification(v_user.id, 'pin_reset_otp',
        jsonb_build_object('otp_code', v_code, 'otp', v_code));
    EXCEPTION WHEN OTHERS THEN
      -- TOO_SOON / TOO_MANY_REQUESTS: el código anterior sigue valiendo. No se informa.
      NULL;
    END;
  END IF;

  RETURN jsonb_build_object('success', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_pin_reset(p_email text, p_code text, p_new_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid;
  v_check jsonb;
BEGIN
  IF COALESCE(p_new_pin, '') !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_NEW_PIN');
  END IF;

  SELECT id INTO v_uid FROM public.users
   WHERE lower(email) = lower(trim(COALESCE(p_email, '')))
     AND verification_status <> 'suspended';
  IF v_uid IS NULL THEN
    -- Igual que un email sin código pedido
    RETURN jsonb_build_object('success', false, 'error', 'CODE_EXPIRED');
  END IF;

  v_check := public._otp_verify('pin_reset', v_uid, NULL, p_code);
  IF NOT (v_check->>'success')::boolean THEN
    RETURN v_check;
  END IF;

  UPDATE public.users
     SET pin_hash = crypt(p_new_pin, gen_salt('bf', 10)), pin_upgrade_required = false
   WHERE id = v_uid;
  DELETE FROM public.pin_login_attempts WHERE user_id = v_uid;
  -- Quien tuviera una sesión abierta con el PIN anterior queda afuera
  DELETE FROM auth.sessions WHERE user_id = v_uid;

  PERFORM public.enqueue_notification(v_uid, 'pin_changed', '{}'::jsonb);
  RETURN jsonb_build_object('success', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.request_pin_reset(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.confirm_pin_reset(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_pin_reset(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_pin_reset(text, text, text) TO anon, authenticated;

-- Plantilla del correo: la misma que la del cambio de PIN, con el texto de recuperación
INSERT INTO public.notification_types (code, name, description, priority, template_title, template_message, email_template_html)
SELECT 'pin_reset_otp', 'Recuperar PIN - Código de Verificación',
       'Código OTP enviado al usuario que olvidó su PIN.', 1,
       '{"es": "Código para recuperar tu PIN", "en": "PIN recovery code"}'::jsonb,
       '{"es": "Tu código para recuperar el PIN es: {{otp}}. Válido por 10 minutos.", "en": "Your PIN recovery code is: {{otp}}. Valid for 10 minutes."}'::jsonb,
       jsonb_build_object('es', replace(replace(replace(replace(
         email_template_html->>'es',
         '<title>Cambio de PIN - Magnate</title>', '<title>Recuperar PIN - Magnate</title>'),
         'Cambio de PIN de acceso', 'Recuperación de PIN'),
         'Recibimos una solicitud para cambiar tu PIN de acceso', 'Recibimos una solicitud para recuperar tu PIN de acceso'),
         'Si no solicitaste este cambio, te recomendamos cambiar tu PIN inmediatamente y contactar soporte.',
         'Si no lo pediste vos, ignorá este correo: tu PIN no cambia mientras nadie use este código.'))
  FROM public.notification_types
 WHERE code = 'pin_change_otp'
ON CONFLICT (code) DO UPDATE
  SET template_title = EXCLUDED.template_title,
      template_message = EXCLUDED.template_message,
      email_template_html = EXCLUDED.email_template_html;
