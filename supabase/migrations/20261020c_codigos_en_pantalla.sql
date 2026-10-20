-- Mostrar en pantalla los códigos que se envían por email, solo en el entorno de desarrollo.
--
-- app_settings.show_codes_on_screen (bool, por defecto false). Se cambia desde el panel
-- (Configuración → Entorno y verificación de identidad). Nunca vale en producción: al pasar a
-- producción se apaga solo y no se puede encender.
--
-- Con la opción encendida, estas funciones devuelven además debug_code (el código enviado):
--   request_signup_email_otp (registro), login_with_pin y resend_device_login_code (dispositivo
--   nuevo), request_pin_change_code (cambio de PIN) y request_transfer_code (transferencia web).
-- request_pin_reset queda afuera a propósito: se pide solo con el email, así que devolver el
-- código permitiría cambiar el PIN de cualquier cuenta.

INSERT INTO public.app_settings (key, value, description) VALUES
  ('show_codes_on_screen', 'false'::jsonb,
   'Mostrar en pantalla los códigos enviados por email (solo en development)')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._debug_code(p_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN public.app_environment() = 'development'
               AND public.get_setting_bool('show_codes_on_screen', false)
              THEN p_code END;
$$;
REVOKE ALL ON FUNCTION public._debug_code(text) FROM PUBLIC, anon, authenticated;

-- Valores válidos: 'simulated' y show_codes_on_screen nunca en producción
CREATE OR REPLACE FUNCTION public.guard_environment_settings()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.key = 'app_environment' THEN
    IF NEW.value #>> '{}' NOT IN ('development', 'production') OR jsonb_typeof(NEW.value) <> 'string' THEN
      RAISE EXCEPTION 'INVALID_SETTING: app_environment debe ser "development" o "production"';
    END IF;
  ELSIF NEW.key = 'identity_verification_mode' THEN
    IF NEW.value #>> '{}' NOT IN ('zapsign', 'simulated') OR jsonb_typeof(NEW.value) <> 'string' THEN
      RAISE EXCEPTION 'INVALID_SETTING: identity_verification_mode debe ser "zapsign" o "simulated"';
    END IF;
    IF NEW.value #>> '{}' = 'simulated' AND public.app_environment() = 'production' THEN
      RAISE EXCEPTION 'INVALID_SETTING: la verificación simulada no se permite en producción';
    END IF;
  ELSIF NEW.key = 'show_codes_on_screen' THEN
    IF jsonb_typeof(NEW.value) <> 'boolean' THEN
      RAISE EXCEPTION 'INVALID_SETTING: show_codes_on_screen debe ser true o false';
    END IF;
    IF NEW.value = 'true'::jsonb AND public.app_environment() = 'production' THEN
      RAISE EXCEPTION 'INVALID_SETTING: los códigos en pantalla no se permiten en producción';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.on_environment_changed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.key = 'app_environment' AND NEW.value #>> '{}' = 'production' THEN
    UPDATE public.app_settings
       SET value = '"zapsign"'::jsonb, updated_at = now()
     WHERE key = 'identity_verification_mode' AND value #>> '{}' <> 'zapsign';
    UPDATE public.app_settings
       SET value = 'false'::jsonb, updated_at = now()
     WHERE key = 'show_codes_on_screen' AND value <> 'false'::jsonb;
  END IF;
  RETURN NULL;
END;
$function$;

-- Panel: estado y cambio (se agrega show_codes_on_screen)
CREATE OR REPLACE FUNCTION public.admin_environment_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_names text[];
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  SELECT COALESCE(array_agg(name), '{}') INTO v_names
    FROM vault.decrypted_secrets
   WHERE name LIKE 'zapsign\_%' AND length(trim(COALESCE(decrypted_secret, ''))) > 0;

  RETURN jsonb_build_object(
    'environment', public.app_environment(),
    'identity_verification', public.identity_verification_mode(),
    'show_codes_on_screen', public.app_environment() = 'development' AND public.get_setting_bool('show_codes_on_screen', false),
    'sandbox_configured', v_names @> ARRAY['zapsign_api_key_sandbox', 'zapsign_template_id_sandbox'],
    'production_configured', v_names @> ARRAY['zapsign_api_key_prod', 'zapsign_template_id_prod'],
    'production_biometric', 'zapsign_selfie_validation_type_prod' = ANY(v_names),
    'updated_at', (SELECT max(updated_at) FROM public.app_settings
                    WHERE key IN ('app_environment', 'identity_verification_mode', 'show_codes_on_screen'))
  );
END;
$$;

DROP FUNCTION IF EXISTS public.admin_set_environment_settings(text, text);
CREATE OR REPLACE FUNCTION public.admin_set_environment_settings(
  p_environment text,
  p_identity_verification text,
  p_show_codes_on_screen boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_show jsonb := to_jsonb(COALESCE(p_show_codes_on_screen, false));
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_environment IS NULL OR p_environment NOT IN ('development', 'production') THEN
    RAISE EXCEPTION 'INVALID_SETTING: El entorno debe ser desarrollo o producción';
  END IF;
  IF p_identity_verification IS NULL OR p_identity_verification NOT IN ('zapsign', 'simulated') THEN
    RAISE EXCEPTION 'INVALID_SETTING: Modo de verificación inválido';
  END IF;
  IF p_environment = 'production' AND p_identity_verification = 'simulated' THEN
    RAISE EXCEPTION 'INVALID_SETTING: La verificación simulada no se permite en producción';
  END IF;
  IF p_environment = 'production' AND COALESCE(p_show_codes_on_screen, false) THEN
    RAISE EXCEPTION 'INVALID_SETTING: Los códigos en pantalla no se permiten en producción';
  END IF;
  IF p_environment = 'production' AND NOT (public.admin_environment_settings()->>'production_configured')::boolean THEN
    RAISE EXCEPTION 'PROD_CREDENTIALS_MISSING: Faltan las credenciales de ZapSign de producción en Supabase Vault (zapsign_api_key_prod y zapsign_template_id_prod)';
  END IF;

  -- Lo que solo vale en desarrollo se apaga antes de cambiar el entorno y se enciende después:
  -- así los triggers nunca ven una opción de pruebas con producción.
  IF p_identity_verification = 'zapsign' THEN
    UPDATE public.app_settings SET value = to_jsonb(p_identity_verification), updated_at = now(), updated_by = auth.uid()
     WHERE key = 'identity_verification_mode' AND value <> to_jsonb(p_identity_verification);
  END IF;
  IF NOT COALESCE(p_show_codes_on_screen, false) THEN
    UPDATE public.app_settings SET value = v_show, updated_at = now(), updated_by = auth.uid()
     WHERE key = 'show_codes_on_screen' AND value <> v_show;
  END IF;
  UPDATE public.app_settings SET value = to_jsonb(p_environment), updated_at = now(), updated_by = auth.uid()
   WHERE key = 'app_environment' AND value <> to_jsonb(p_environment);
  IF p_identity_verification = 'simulated' THEN
    UPDATE public.app_settings SET value = to_jsonb(p_identity_verification), updated_at = now(), updated_by = auth.uid()
     WHERE key = 'identity_verification_mode' AND value <> to_jsonb(p_identity_verification);
  END IF;
  IF COALESCE(p_show_codes_on_screen, false) THEN
    INSERT INTO public.app_settings (key, value, updated_at, updated_by)
    VALUES ('show_codes_on_screen', v_show, now(), auth.uid())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_environment_settings(text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_environment_settings(text, text, boolean) TO authenticated;

-- Funciones que envían códigos: devuelven debug_code solo con la opción encendida en desarrollo

CREATE OR REPLACE FUNCTION public.request_signup_email_otp(p_email text, p_first_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_email text := lower(trim(COALESCE(p_email, '')));
  v_code text;
  v_ttl interval := interval '10 minutes';
BEGIN
  IF v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'INVALID_EMAIL: Email inválido';
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE lower(email) = v_email) THEN
    RAISE EXCEPTION 'EMAIL_IN_USE: Ya existe una cuenta con ese email';
  END IF;

  -- Límite: 1 código por minuto y 5 por hora por email
  IF EXISTS (
    SELECT 1 FROM public.email_otps
     WHERE lower(email) = v_email AND purpose = 'signup'
       AND created_at > now() - interval '60 seconds'
  ) THEN
    RAISE EXCEPTION 'TOO_SOON: Espera un minuto antes de pedir otro código';
  END IF;

  IF (SELECT count(*) FROM public.email_otps
       WHERE lower(email) = v_email AND purpose = 'signup'
         AND created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'TOO_MANY_REQUESTS: Demasiados códigos solicitados. Intenta más tarde';
  END IF;

  -- Invalidar códigos anteriores sin usar
  UPDATE public.email_otps SET used = true
   WHERE lower(email) = v_email AND purpose = 'signup' AND NOT used;

  -- Código aleatorio criptográficamente seguro de 6 dígitos
  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');

  INSERT INTO public.email_otps (email, code_hash, expires_at, purpose)
  VALUES (v_email, crypt(v_code, gen_salt('bf')), now() + v_ttl, 'signup');

  PERFORM public.enqueue_notification(
    NULL,
    'email_verification',
    jsonb_build_object(
      'email', v_email,
      'first_name', COALESCE(NULLIF(trim(p_first_name), ''), split_part(v_email, '@', 1)),
      'otp', v_code,
      'otp_code', v_code
    )
  );

  RETURN jsonb_strip_nulls(jsonb_build_object('success', true, 'expires_in_seconds', extract(epoch FROM v_ttl)::int,
                                             'debug_code', public._debug_code(v_code)));
END;
$function$;

CREATE OR REPLACE FUNCTION public.login_with_pin(p_email text, p_pin text, p_device jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user record;
  v_pin jsonb;
  v_code text;
  v_sent boolean := true;
BEGIN
  SELECT u.id, u.email, u.first_name, u.verification_status, u.account_type, u.status_reason,
         c.auto_password_encrypted
    INTO v_user
    FROM public.users u
    LEFT JOIN public.user_auth_credentials c ON c.user_id = u.id
   WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  IF v_user.verification_status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'SUSPENDED');
  END IF;

  v_pin := public._check_pin(v_user.id, p_pin);
  IF NOT (v_pin->>'success')::boolean THEN
    RETURN v_pin;
  END IF;

  -- El PIN ahora es de 6 dígitos. Un PIN viejo (4) sigue entrando, pero la app obliga a
  -- cambiarlo y las transferencias quedan bloqueadas hasta hacerlo.
  IF COALESCE(p_pin, '') !~ '^\d{6}$' THEN
    UPDATE public.users SET pin_upgrade_required = true WHERE id = v_user.id AND NOT pin_upgrade_required;
  END IF;

  IF v_user.verification_status = 'rejected' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REJECTED', 'status_reason', v_user.status_reason);
  END IF;
  IF v_user.verification_status NOT IN ('verified', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_VERIFIED');
  END IF;
  IF v_user.auto_password_encrypted IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'MISSING_CREDENTIALS');
  END IF;

  -- Versiones viejas de la app no envían el dispositivo
  IF p_device IS NULL OR NOT public._valid_device(p_device) THEN
    RETURN jsonb_build_object('success', false, 'error', 'UPDATE_REQUIRED');
  END IF;

  -- Cuenta de revisión de las tiendas: el dispositivo queda de confianza sin código
  IF COALESCE((SELECT value FROM public.app_settings WHERE key = 'device_verification_bypass_emails'), '[]'::jsonb)
       ? lower(v_user.email) THEN
    PERFORM public._trust_device(v_user.id, p_device);
  END IF;

  IF public._trusted_device_id(v_user.id, p_device) IS NOT NULL THEN
    UPDATE public.user_devices SET last_active_at = now()
     WHERE user_id = v_user.id AND device_id = p_device->>'id';
    RETURN jsonb_build_object(
      'success', true,
      'user_id', v_user.id,
      'verification_status', v_user.verification_status,
      'account_type', v_user.account_type,
      'pin_upgrade_required', COALESCE(p_pin, '') !~ '^\d{6}$',
      'auto_password_encrypted', v_user.auto_password_encrypted
    );
  END IF;

  -- Dispositivo nuevo: enviar código por email. NO se entrega la credencial.
  BEGIN
    v_code := public._otp_issue('device', v_user.id, v_user.email, p_device->>'id');
  EXCEPTION WHEN OTHERS THEN
    -- Hay un código reciente para este usuario: el anterior sigue valiendo
    IF SQLERRM LIKE 'TOO_SOON%' OR SQLERRM LIKE 'TOO_MANY_REQUESTS%' THEN
      v_sent := false;
    ELSE
      RAISE;
    END IF;
  END;

  IF v_sent THEN
    PERFORM public.enqueue_notification(v_user.id, 'device_verification', jsonb_build_object(
      'otp_code', v_code,
      'device_name', COALESCE(NULLIF(p_device->>'name', ''), p_device->>'model', 'un dispositivo nuevo')
    ));
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object('success', false, 'error', 'DEVICE_VERIFICATION_REQUIRED', 'code_sent', v_sent,
                                             'debug_code', public._debug_code(v_code)));
END;
$function$;

CREATE OR REPLACE FUNCTION public.resend_device_login_code(p_email text, p_device jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user record;
  v_code text;
BEGIN
  SELECT id, email INTO v_user FROM public.users WHERE lower(email) = lower(trim(COALESCE(p_email, '')));
  IF NOT FOUND OR p_device IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.email_otps
     WHERE user_id = v_user.id AND purpose = 'device' AND binding = p_device->>'id'
       AND created_at > now() - interval '30 minutes'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'LOGIN_AGAIN');
  END IF;

  BEGIN
    v_code := public._otp_issue('device', v_user.id, v_user.email, p_device->>'id');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', split_part(SQLERRM, ':', 1));
  END;

  PERFORM public.enqueue_notification(v_user.id, 'device_verification', jsonb_build_object(
    'otp_code', v_code,
    'device_name', COALESCE(NULLIF(p_device->>'name', ''), p_device->>'model', 'un dispositivo nuevo')
  ));
  RETURN jsonb_strip_nulls(jsonb_build_object('success', true, 'debug_code', public._debug_code(v_code)));
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_pin_change_code(p_current_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_pin jsonb;
  v_code text;
BEGIN
  SELECT email INTO v_email FROM public.users WHERE id = v_uid;
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  v_pin := public._check_pin(v_uid, p_current_pin);
  IF NOT (v_pin->>'success')::boolean THEN
    RETURN v_pin;
  END IF;

  BEGIN
    v_code := public._otp_issue('pin_change', v_uid, v_email, NULL);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', split_part(SQLERRM, ':', 1));
  END;

  PERFORM public.enqueue_notification(v_uid, 'pin_change_otp', jsonb_build_object('otp_code', v_code, 'otp', v_code));
  RETURN jsonb_strip_nulls(jsonb_build_object('success', true, 'debug_code', public._debug_code(v_code)));
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_transfer_code(p_from_account_id uuid, p_to_identifier character varying, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_email text;
  v_code text;
  v_recipient text;
  v_formatted text;
BEGIN
  SELECT u.email INTO v_email
    FROM public.accounts a JOIN public.users u ON u.id = a.user_id
   WHERE a.id = p_from_account_id AND a.user_id = v_uid;
  IF v_email IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR trim(COALESCE(p_to_identifier, '')) = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_TRANSFER');
  END IF;

  SELECT holder_name INTO v_recipient FROM public.search_account_for_transfer(p_to_identifier) LIMIT 1;
  v_formatted := '$ ' || replace(replace(replace(to_char(round(p_amount, 2), 'FM999,999,999,990.00'), ',', '#'), '.', ','), '#', '.');

  BEGIN
    v_code := public._otp_issue('transfer', v_uid, v_email,
                                public._transfer_binding(p_from_account_id, p_to_identifier, p_amount),
                                interval '5 minutes');
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', split_part(SQLERRM, ':', 1));
  END;

  PERFORM public.enqueue_notification(v_uid, 'transfer_otp', jsonb_build_object(
    'otp_code', v_code,
    'amount_formatted', v_formatted,
    'recipient_name', COALESCE(v_recipient, p_to_identifier)
  ));
  RETURN jsonb_strip_nulls(jsonb_build_object('success', true, 'expires_in_seconds', 300, 'debug_code', public._debug_code(v_code)));
END;
$function$;
