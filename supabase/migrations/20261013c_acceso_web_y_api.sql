-- =============================================================================
-- Auditoría (2026-10-13): acceso web, login web y acceso API
--
-- * users: desde la API el usuario solo puede cambiar su foto y su teléfono.
--   Antes podía activarse el acceso web con la contraseña que quisiera
--   (web_access_enabled / web_password_hash) y cambiar sus datos de KYC.
-- * set_web_access: activar el acceso web o cambiar su contraseña exige el PIN;
--   el hash se calcula en la BD. Se avisa por email.
-- * web_login_check: valida email + contraseña web en la BD con límite de
--   intentos (5 cada 15 minutos por email) y un único mensaje de error.
--   La edge function web-login ya no devuelve la contraseña de Supabase Auth:
--   crea la sesión en el servidor.
-- * api-setup valida el PIN con _check_pin (service_role) y avisa por email.
-- =============================================================================

-- 1. users: lista de columnas que el usuario puede modificar ------------------
CREATE OR REPLACE FUNCTION public.protect_user_sensitive_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  -- Lo único que el usuario puede cambiar de su propia fila desde la API
  v_editable constant text[] := ARRAY['photo_url', 'phone', 'updated_at'];
BEGIN
  -- Solo aplica a llamadas directas desde la API (roles anon / authenticated).
  -- Las funciones SECURITY DEFINER y el service_role no pasan por aquí.
  IF current_user IN ('anon', 'authenticated') AND NOT public.is_admin() THEN
    IF (to_jsonb(NEW) - v_editable) IS DISTINCT FROM (to_jsonb(OLD) - v_editable) THEN
      RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 2. Avisos por email --------------------------------------------------------
INSERT INTO public.notification_types (code, name, description, priority, template_title, template_message, default_enabled, email_template_html)
SELECT v.code, v.name, v.description, 1, v.title, v.message, true, nt.email_template_html
  FROM (VALUES
    ('web_access_changed', 'Acceso web modificado', 'Aviso de activación o cambio de contraseña del acceso web',
     '{"es": "Cambios en tu acceso web", "en": "Your web access changed"}'::jsonb,
     '{"es": "{{detail}}", "en": "{{detail}}"}'::jsonb),
    ('api_access_changed', 'Acceso API modificado', 'Aviso de cambios en el acceso API',
     '{"es": "Cambios en tu acceso API", "en": "Your API access changed"}'::jsonb,
     '{"es": "{{detail}}", "en": "{{detail}}"}'::jsonb)
  ) AS v(code, name, description, title, message)
  -- Misma plantilla que el aviso de cambio de PIN ("si no fuiste tú, contacta a soporte")
  CROSS JOIN (SELECT email_template_html FROM public.notification_types WHERE code = 'pin_changed') nt
ON CONFLICT (code) DO NOTHING;

-- 3. Activar / desactivar el acceso web --------------------------------------
CREATE OR REPLACE FUNCTION public.set_web_access(p_enabled boolean, p_pin text DEFAULT NULL, p_password text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_was_enabled boolean;
  v_pin jsonb;
BEGIN
  SELECT web_access_enabled INTO v_was_enabled FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  -- Desactivar no necesita PIN (es la dirección segura)
  IF NOT p_enabled THEN
    UPDATE public.users SET web_access_enabled = false, updated_at = now() WHERE id = v_uid;
    IF v_was_enabled THEN
      PERFORM public.enqueue_notification(v_uid, 'web_access_changed',
        jsonb_build_object('detail', 'Se desactivó el acceso web a tu cuenta Magnate.'));
    END IF;
    RETURN jsonb_build_object('success', true);
  END IF;

  IF p_password IS NULL OR length(p_password) < 8 OR length(p_password) > 72
     OR p_password !~ '[A-Z]' OR p_password !~ '[0-9]' OR p_password !~ '[!@#$%^&*(),.?":{}|<>]' THEN
    RETURN jsonb_build_object('success', false, 'error', 'WEAK_PASSWORD');
  END IF;

  v_pin := public._check_pin(v_uid, p_pin);
  IF NOT (v_pin->>'success')::boolean THEN
    RETURN v_pin;
  END IF;

  UPDATE public.users
     SET web_access_enabled = true,
         web_password_hash = crypt(p_password, gen_salt('bf', 10)),
         web_access_enabled_at = CASE WHEN v_was_enabled THEN web_access_enabled_at ELSE now() END,
         updated_at = now()
   WHERE id = v_uid;
  -- La contraseña nueva vale de inmediato: se olvidan los intentos fallidos
  DELETE FROM public.web_login_attempts
   WHERE email = (SELECT lower(email) FROM public.users WHERE id = v_uid);

  PERFORM public.enqueue_notification(v_uid, 'web_access_changed', jsonb_build_object('detail',
    CASE WHEN v_was_enabled THEN 'Se cambió la contraseña de acceso web de tu cuenta Magnate.'
         ELSE 'Se activó el acceso web a tu cuenta Magnate.' END));
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 4. Login web con límite de intentos -----------------------------------------
CREATE TABLE IF NOT EXISTS public.web_login_attempts (
  email text PRIMARY KEY,
  failed_count int NOT NULL DEFAULT 0,
  last_failed_at timestamptz,
  locked_until timestamptz
);
ALTER TABLE public.web_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.web_login_attempts FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.set_web_access(boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_web_access(boolean, text, text) TO authenticated;

-- Solo la usa la edge function web-login (service_role)
CREATE OR REPLACE FUNCTION public.web_login_check(p_email text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_max_attempts constant int := 5;
  v_window constant interval := interval '15 minutes';
  v_lock constant interval := interval '15 minutes';
  v_email text := lower(trim(COALESCE(p_email, '')));
  v_user record;
  v_hash text;
  v_attempts public.web_login_attempts%ROWTYPE;
  v_failed int;
BEGIN
  IF v_email = '' OR COALESCE(p_password, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_CREDENTIALS');
  END IF;

  -- El límite es por email, exista o no la cuenta (no revela cuáles existen)
  SELECT * INTO v_attempts FROM public.web_login_attempts WHERE email = v_email FOR UPDATE;
  IF v_attempts.locked_until IS NOT NULL AND v_attempts.locked_until > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'LOCKED',
      'retry_after_seconds', ceil(extract(epoch FROM v_attempts.locked_until - now()))::int);
  END IF;

  SELECT id, email, first_name, last_name, verification_status, web_access_enabled, web_password_hash
    INTO v_user
    FROM public.users
   WHERE lower(email) = v_email;

  v_hash := COALESCE(v_user.web_password_hash, '');
  IF v_hash ~ '^\$2[aby]\$\d\d\$.{53}$' THEN
    v_hash := '$2a$' || substr(v_hash, 5);   -- bcryptjs usa $2b$; pgcrypto acepta $2a$
  ELSE
    v_hash := NULL;
  END IF;

  IF v_user.id IS NOT NULL AND v_user.web_access_enabled AND v_hash IS NOT NULL
     AND crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.web_login_attempts WHERE email = v_email;
    IF v_user.verification_status <> 'verified' THEN
      RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_' || upper(COALESCE(v_user.verification_status, 'unknown')));
    END IF;
    RETURN jsonb_build_object('success', true, 'user_id', v_user.id, 'email', v_user.email);
  END IF;

  v_failed := CASE
    WHEN v_attempts.email IS NULL OR v_attempts.last_failed_at IS NULL
         OR v_attempts.last_failed_at < now() - v_window THEN 1
    ELSE v_attempts.failed_count + 1
  END;
  INSERT INTO public.web_login_attempts (email, failed_count, last_failed_at, locked_until)
  VALUES (v_email, v_failed, now(), NULL)
  ON CONFLICT (email) DO UPDATE
    SET failed_count = EXCLUDED.failed_count, last_failed_at = now(), locked_until = NULL;

  IF v_failed >= v_max_attempts THEN
    UPDATE public.web_login_attempts SET failed_count = 0, locked_until = now() + v_lock WHERE email = v_email;
    RETURN jsonb_build_object('success', false, 'error', 'LOCKED', 'retry_after_seconds', extract(epoch FROM v_lock)::int);
  END IF;
  RETURN jsonb_build_object('success', false, 'error', 'INVALID_CREDENTIALS');
END;
$$;
REVOKE ALL ON FUNCTION public.web_login_check(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_login_check(text, text) TO service_role;

-- 5. api-setup valida el PIN con _check_pin (llamado con service_role) --------
REVOKE ALL ON FUNCTION public._check_pin(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._check_pin(uuid, text) TO service_role;
