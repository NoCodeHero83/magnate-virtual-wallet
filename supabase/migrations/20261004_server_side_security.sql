-- =============================================================================
-- Controles de seguridad del lado del servidor
-- Fecha: 2026-10-04
--
-- 1. La suspensión de un usuario bloquea su cuenta bancaria.
-- 2. Códigos de un solo uso (OTP) generados y validados en la BD.
-- 3. Dispositivos de confianza: la credencial de login solo se entrega a un
--    dispositivo verificado (secreto del dispositivo) o tras validar el código
--    enviado por email. Antes la sesión se abría ANTES del código y OneSignal
--    marcaba el dispositivo como activo, por lo que la verificación no protegía.
-- 4. Cambio de PIN: requiere PIN actual + código, validados en la BD.
-- 5. Transferencias: la app solo desde un dispositivo de confianza y la web
--    con código. process_transfer ya no se puede llamar directamente
--    (la API externa usa service_role y no cambia).
--
-- Respaldo: supabase/backup/20261004_antes_server_side_security.sql
-- =============================================================================

BEGIN;

-- =============================================================================
-- 1. Suspensión => cuenta bancaria bloqueada
-- =============================================================================
CREATE OR REPLACE FUNCTION public.sync_accounts_on_user_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.verification_status = 'suspended' AND OLD.verification_status IS DISTINCT FROM 'suspended' THEN
    UPDATE public.accounts
       SET status = 'blocked', status_reason = 'user_suspended'
     WHERE user_id = NEW.id AND status = 'active';
  ELSIF OLD.verification_status = 'suspended' AND NEW.verification_status IS DISTINCT FROM 'suspended' THEN
    UPDATE public.accounts
       SET status = 'active', status_reason = NULL
     WHERE user_id = NEW.id AND status = 'blocked' AND status_reason = 'user_suspended';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_sync_accounts_on_user_status ON public.users;
CREATE TRIGGER trigger_sync_accounts_on_user_status
  AFTER UPDATE OF verification_status ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_accounts_on_user_status();

-- Usuarios que ya estaban suspendidos
UPDATE public.accounts a
   SET status = 'blocked', status_reason = 'user_suspended'
  FROM public.users u
 WHERE u.id = a.user_id AND u.verification_status = 'suspended' AND a.status = 'active';

-- =============================================================================
-- 2. OTP genéricos (uso interno)
-- =============================================================================
ALTER TABLE public.email_otps
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS binding text;

CREATE INDEX IF NOT EXISTS idx_email_otps_user_purpose
  ON public.email_otps (user_id, purpose, created_at DESC);

-- Genera un código (hash bcrypt en la BD) con límite de envíos:
-- 1 por minuto y 5 por hora por usuario y propósito. Invalida los anteriores.
CREATE OR REPLACE FUNCTION public._otp_issue(p_purpose text, p_user_id uuid, p_email text, p_binding text,
                                             p_ttl interval DEFAULT interval '10 minutes')
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_code text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.email_otps
              WHERE user_id = p_user_id AND purpose = p_purpose
                AND created_at > now() - interval '60 seconds') THEN
    RAISE EXCEPTION 'TOO_SOON: Espera un minuto antes de pedir otro código';
  END IF;
  IF (SELECT count(*) FROM public.email_otps
       WHERE user_id = p_user_id AND purpose = p_purpose
         AND created_at > now() - interval '1 hour') >= 5 THEN
    RAISE EXCEPTION 'TOO_MANY_REQUESTS: Demasiados códigos solicitados. Intenta más tarde';
  END IF;

  UPDATE public.email_otps SET used = true
   WHERE user_id = p_user_id AND purpose = p_purpose AND NOT used;

  v_code := lpad(((('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0');

  INSERT INTO public.email_otps (email, user_id, purpose, binding, code_hash, expires_at)
  VALUES (lower(p_email), p_user_id, p_purpose, p_binding, crypt(v_code, gen_salt('bf')), now() + p_ttl);

  RETURN v_code;
END;
$$;

-- Valida el último código del usuario para ese propósito. Máximo 5 intentos.
-- Devuelve jsonb (no lanza excepción) para que el contador de intentos persista.
CREATE OR REPLACE FUNCTION public._otp_verify(p_purpose text, p_user_id uuid, p_binding text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_otp public.email_otps%ROWTYPE;
BEGIN
  SELECT * INTO v_otp FROM public.email_otps
   WHERE user_id = p_user_id AND purpose = p_purpose AND NOT used
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND OR v_otp.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'CODE_EXPIRED');
  END IF;

  -- El código se emitió para otra operación (otro dispositivo / otra transferencia)
  IF v_otp.binding IS DISTINCT FROM p_binding THEN
    RETURN jsonb_build_object('success', false, 'error', 'CODE_MISMATCH');
  END IF;

  IF v_otp.attempts >= 5 THEN
    UPDATE public.email_otps SET used = true WHERE id = v_otp.id;
    RETURN jsonb_build_object('success', false, 'error', 'TOO_MANY_ATTEMPTS');
  END IF;

  IF crypt(trim(COALESCE(p_code, '')), v_otp.code_hash) = v_otp.code_hash THEN
    UPDATE public.email_otps SET used = true, verified_at = now() WHERE id = v_otp.id;
    RETURN jsonb_build_object('success', true);
  END IF;

  UPDATE public.email_otps SET attempts = attempts + 1 WHERE id = v_otp.id;
  IF v_otp.attempts + 1 >= 5 THEN
    UPDATE public.email_otps SET used = true WHERE id = v_otp.id;
    RETURN jsonb_build_object('success', false, 'error', 'TOO_MANY_ATTEMPTS');
  END IF;
  RETURN jsonb_build_object('success', false, 'error', 'INVALID_CODE',
                            'attempts_left', 4 - v_otp.attempts);
END;
$$;

REVOKE ALL ON FUNCTION public._otp_issue(text, uuid, text, text, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._otp_verify(text, uuid, text, text) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 3. PIN: validación compartida (login y cambio de PIN)
--    3 fallos en 15 min => bloqueo de 15 min. Devuelve jsonb.
-- =============================================================================
CREATE OR REPLACE FUNCTION public._check_pin(p_user_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_max_attempts constant int := 3;
  v_window constant interval := interval '15 minutes';
  v_lock constant interval := interval '15 minutes';
  v_hash text;
  v_attempts public.pin_login_attempts%ROWTYPE;
  v_failed int;
BEGIN
  SELECT * INTO v_attempts FROM public.pin_login_attempts WHERE user_id = p_user_id FOR UPDATE;

  IF v_attempts.locked_until IS NOT NULL AND v_attempts.locked_until > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN_LOCKED',
      'retry_after_seconds', ceil(extract(epoch FROM v_attempts.locked_until - now()))::int);
  END IF;

  SELECT pin_hash INTO v_hash FROM public.users WHERE id = p_user_id;
  v_hash := COALESCE(v_hash, '');
  -- bcryptjs genera $2b$; pgcrypto solo acepta $2a$ (mismo algoritmo)
  IF v_hash !~ '^\$2[aby]\$\d\d\$.{53}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'CORRUPT_CREDENTIALS');
  END IF;
  v_hash := '$2a$' || substr(v_hash, 5);

  IF crypt(COALESCE(p_pin, ''), v_hash) = v_hash THEN
    DELETE FROM public.pin_login_attempts WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', true);
  END IF;

  v_failed := CASE
    WHEN v_attempts.user_id IS NULL OR v_attempts.last_failed_at IS NULL
         OR v_attempts.last_failed_at < now() - v_window THEN 1
    ELSE v_attempts.failed_count + 1
  END;

  INSERT INTO public.pin_login_attempts (user_id, failed_count, last_failed_at, locked_until)
  VALUES (p_user_id, v_failed, now(), NULL)
  ON CONFLICT (user_id) DO UPDATE
    SET failed_count = EXCLUDED.failed_count, last_failed_at = now(), locked_until = NULL;

  IF v_failed >= v_max_attempts THEN
    UPDATE public.pin_login_attempts
       SET failed_count = 0, locked_until = now() + v_lock
     WHERE user_id = p_user_id;
    RETURN jsonb_build_object('success', false, 'error', 'PIN_LOCKED',
      'retry_after_seconds', extract(epoch FROM v_lock)::int);
  END IF;

  RETURN jsonb_build_object('success', false, 'error', 'INVALID_PIN',
                            'attempts_left', v_max_attempts - v_failed);
END;
$$;
REVOKE ALL ON FUNCTION public._check_pin(uuid, text) FROM PUBLIC, anon, authenticated;

-- El usuario ya no puede cambiar su pin_hash directamente (solo con confirm_pin_change)
CREATE OR REPLACE FUNCTION public.protect_user_sensitive_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
BEGIN
  -- Solo aplica a llamadas directas desde la API (roles anon / authenticated).
  -- Las funciones SECURITY DEFINER y el service_role no pasan por aquí.
  IF current_user IN ('anon', 'authenticated') AND NOT public.is_admin() THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
       OR NEW.account_type IS DISTINCT FROM OLD.account_type
       OR NEW.status_reason IS DISTINCT FROM OLD.status_reason
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.pin_hash IS DISTINCT FROM OLD.pin_hash THEN
      RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- El hash del PIN no debe viajar en el JWT (user_metadata). Se usaba solo al crear el perfil.
UPDATE auth.users
   SET raw_user_meta_data = raw_user_meta_data - 'pin_hash'
 WHERE raw_user_meta_data ? 'pin_hash';

-- =============================================================================
-- 4. Dispositivos de confianza
-- =============================================================================
ALTER TABLE public.user_devices
  ADD COLUMN IF NOT EXISTS secret_hash text,
  ADD COLUMN IF NOT EXISTS trusted_at timestamptz;

-- Los dispositivos existentes no tienen secreto: se verifican de nuevo una vez
-- con el código por email (QA, sin usuarios reales).

CREATE OR REPLACE FUNCTION public._device_secret_hash(p_secret text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions'
AS $$ SELECT encode(digest(p_secret, 'sha256'), 'hex'); $$;

-- p_device: {"id","secret","name","model","platform","os_version","app_version"}
CREATE OR REPLACE FUNCTION public._valid_device(p_device jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(length(p_device->>'id'), 0) BETWEEN 8 AND 128
     AND COALESCE(length(p_device->>'secret'), 0) BETWEEN 32 AND 256;
$$;

-- id del registro de user_devices si el dispositivo es de confianza para el usuario
CREATE OR REPLACE FUNCTION public._trusted_device_id(p_user_id uuid, p_device jsonb)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.id FROM public.user_devices d
   WHERE public._valid_device(p_device)
     AND d.user_id = p_user_id
     AND d.device_id = p_device->>'id'
     AND d.status = 'active'
     AND d.trusted_at IS NOT NULL
     AND d.secret_hash = public._device_secret_hash(p_device->>'secret')
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public._trust_device(p_user_id uuid, p_device jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid;
  v_platform text := CASE WHEN p_device->>'platform' IN ('ios', 'android') THEN p_device->>'platform' END;
BEGIN
  IF NOT public._valid_device(p_device) THEN
    RAISE EXCEPTION 'INVALID_DEVICE: Datos del dispositivo inválidos';
  END IF;

  INSERT INTO public.user_devices (
    user_id, device_id, device_name, device_model, platform, os_version, app_version,
    status, is_active, secret_hash, trusted_at, registered_at, last_active_at
  ) VALUES (
    p_user_id, p_device->>'id', left(p_device->>'name', 100), left(p_device->>'model', 100), v_platform,
    left(p_device->>'os_version', 50), left(p_device->>'app_version', 50),
    'active', true, public._device_secret_hash(p_device->>'secret'), now(), now(), now()
  )
  ON CONFLICT (user_id, device_id) DO UPDATE SET
    device_name = COALESCE(EXCLUDED.device_name, user_devices.device_name),
    device_model = COALESCE(EXCLUDED.device_model, user_devices.device_model),
    platform = COALESCE(EXCLUDED.platform, user_devices.platform),
    os_version = COALESCE(EXCLUDED.os_version, user_devices.os_version),
    app_version = COALESCE(EXCLUDED.app_version, user_devices.app_version),
    status = 'active',
    is_active = true,
    secret_hash = EXCLUDED.secret_hash,
    trusted_at = now(),
    revoked_at = NULL,
    revoke_reason = NULL,
    last_active_at = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public._trusted_device_id(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._trust_device(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Emails que no requieren verificar el dispositivo (cuenta de revisión de las tiendas)
INSERT INTO public.app_settings (key, value, description) VALUES
  ('device_verification_bypass_emails', '["oscarmijaelpg@gmail.com"]'::jsonb,
   'Emails que no requieren verificar el dispositivo por código (cuenta de revisión de las tiendas)')
ON CONFLICT (key) DO NOTHING;

-- Los clientes ya no crean ni marcan dispositivos: solo pueden actualizar
-- push_enabled / last_active_at y borrar los propios.
REVOKE INSERT, UPDATE ON public.user_devices FROM anon, authenticated;
GRANT UPDATE (push_enabled, last_active_at) ON public.user_devices TO authenticated;

-- OneSignal: guarda el player_id del dispositivo del usuario de la sesión.
-- Antes aceptaba cualquier p_user_id y creaba el dispositivo como 'active'.
CREATE OR REPLACE FUNCTION public.claim_onesignal_device(p_player_id text, p_device_id text, p_user_id uuid, p_platform text,
                                                         p_push_enabled boolean, p_device_os_version text, p_app_version text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR (p_user_id IS NOT NULL AND p_user_id <> v_uid) THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Sesión inválida';
  END IF;

  -- Libera el player_id si lo tenía otro dispositivo / usuario
  UPDATE user_devices
     SET player_id = NULL
   WHERE player_id = p_player_id
     AND (user_id <> v_uid OR device_id <> p_device_id);

  -- Solo datos de push: NO otorga confianza (status 'pending' si es nuevo)
  INSERT INTO user_devices (user_id, device_id, player_id, platform, push_enabled,
                            device_os_version, app_version, status, is_active, last_active_at)
  VALUES (v_uid, p_device_id, p_player_id,
          CASE WHEN p_platform IN ('ios', 'android') THEN p_platform END,
          p_push_enabled, p_device_os_version, p_app_version, 'pending', true, now())
  ON CONFLICT (user_id, device_id) DO UPDATE SET
    player_id = EXCLUDED.player_id,
    platform = COALESCE(EXCLUDED.platform, user_devices.platform),
    push_enabled = EXCLUDED.push_enabled,
    device_os_version = EXCLUDED.device_os_version,
    app_version = EXCLUDED.app_version,
    last_active_at = now();
END;
$function$;
REVOKE ALL ON FUNCTION public.claim_onesignal_device(text, text, uuid, text, boolean, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_onesignal_device(text, text, uuid, text, boolean, text, text) TO authenticated;

-- ¿El dispositivo de la sesión actual sigue siendo de confianza? (al restaurar la sesión)
CREATE OR REPLACE FUNCTION public.check_device_trust(p_device jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid := public._trusted_device_id(auth.uid(), p_device);
BEGIN
  IF v_id IS NULL THEN
    RETURN false;
  END IF;
  UPDATE public.user_devices SET last_active_at = now() WHERE id = v_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.check_device_trust(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_device_trust(jsonb) TO authenticated;

-- Desvincular un dispositivo propio (pierde la confianza)
CREATE OR REPLACE FUNCTION public.revoke_device(p_device_record_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.user_devices
     SET status = 'revoked', is_active = false, revoked_at = now(),
         revoke_reason = 'Desvinculado por el usuario', secret_hash = NULL, trusted_at = NULL
   WHERE id = p_device_record_id AND user_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'DEVICE_NOT_FOUND: Dispositivo no encontrado';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.revoke_device(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_device(uuid) TO authenticated;

-- Tras el registro: el dispositivo donde se creó la cuenta (con el email ya
-- verificado por código) queda de confianza, para no pedir otro código al entrar.
CREATE OR REPLACE FUNCTION public.trust_signup_device(p_device jsonb)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user public.users%ROWTYPE;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id = auth.uid();
  IF NOT FOUND
     OR v_user.created_at < now() - interval '1 hour'
     OR EXISTS (SELECT 1 FROM public.user_devices WHERE user_id = v_user.id AND trusted_at IS NOT NULL)
     OR NOT public.signup_email_verified(v_user.email) THEN
    RETURN false;
  END IF;
  PERFORM public._trust_device(v_user.id, p_device);
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.trust_signup_device(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trust_signup_device(jsonb) TO authenticated;

-- =============================================================================
-- 5. Login (app): PIN + dispositivo de confianza, o código por email
-- =============================================================================
DROP FUNCTION IF EXISTS public.login_with_pin(text, text);

CREATE OR REPLACE FUNCTION public.login_with_pin(p_email text, p_pin text, p_device jsonb DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
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

  RETURN jsonb_build_object('success', false, 'error', 'DEVICE_VERIFICATION_REQUIRED', 'code_sent', v_sent);
END;
$$;
REVOKE ALL ON FUNCTION public.login_with_pin(text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.login_with_pin(text, text, jsonb) TO anon, authenticated;

-- Valida el código del dispositivo nuevo y recién ahí entrega la credencial
CREATE OR REPLACE FUNCTION public.verify_device_login(p_email text, p_device jsonb, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user record;
  v_check jsonb;
BEGIN
  SELECT u.id, u.verification_status, u.account_type, u.status_reason, c.auto_password_encrypted
    INTO v_user
    FROM public.users u
    LEFT JOIN public.user_auth_credentials c ON c.user_id = u.id
   WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));

  IF NOT FOUND OR p_device IS NULL OR NOT public._valid_device(p_device) THEN
    RETURN jsonb_build_object('success', false, 'error', 'CODE_EXPIRED');
  END IF;

  v_check := public._otp_verify('device', v_user.id, p_device->>'id', p_code);
  IF NOT (v_check->>'success')::boolean THEN
    RETURN v_check;
  END IF;

  -- El estado pudo cambiar mientras tanto
  IF v_user.verification_status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'SUSPENDED');
  END IF;
  IF v_user.verification_status = 'rejected' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REJECTED', 'status_reason', v_user.status_reason);
  END IF;
  IF v_user.auto_password_encrypted IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'MISSING_CREDENTIALS');
  END IF;

  PERFORM public._trust_device(v_user.id, p_device);

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_user.id,
    'verification_status', v_user.verification_status,
    'account_type', v_user.account_type,
    'auto_password_encrypted', v_user.auto_password_encrypted
  );
END;
$$;
REVOKE ALL ON FUNCTION public.verify_device_login(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_device_login(text, jsonb, text) TO anon, authenticated;

-- Reenviar el código del dispositivo: solo si hay un pedido reciente para ese
-- usuario y dispositivo (o sea, alguien ingresó el PIN correcto hace poco)
CREATE OR REPLACE FUNCTION public.resend_device_login_code(p_email text, p_device jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.resend_device_login_code(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resend_device_login_code(text, jsonb) TO anon, authenticated;

-- =============================================================================
-- 6. Cambio de PIN: PIN actual + código
-- =============================================================================
CREATE OR REPLACE FUNCTION public.request_pin_change_code(p_current_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.confirm_pin_change(p_code text, p_new_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text;
  v_check jsonb;
BEGIN
  SELECT pin_hash INTO v_hash FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  IF COALESCE(p_new_pin, '') !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_NEW_PIN');
  END IF;
  IF v_hash ~ '^\$2[aby]\$' AND crypt(p_new_pin, '$2a$' || substr(v_hash, 5)) = '$2a$' || substr(v_hash, 5) THEN
    RETURN jsonb_build_object('success', false, 'error', 'SAME_PIN');
  END IF;

  v_check := public._otp_verify('pin_change', v_uid, NULL, p_code);
  IF NOT (v_check->>'success')::boolean THEN
    RETURN v_check;
  END IF;

  UPDATE public.users SET pin_hash = crypt(p_new_pin, gen_salt('bf', 10)) WHERE id = v_uid;
  DELETE FROM public.pin_login_attempts WHERE user_id = v_uid;

  PERFORM public.enqueue_notification(v_uid, 'pin_changed', '{}'::jsonb);
  RETURN jsonb_build_object('success', true);
END;
$$;
REVOKE ALL ON FUNCTION public.request_pin_change_code(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_pin_change(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_pin_change_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_pin_change(text, text) TO authenticated;

-- =============================================================================
-- 7. Transferencias
-- =============================================================================
CREATE OR REPLACE FUNCTION public._transfer_binding(p_from_account_id uuid, p_to_identifier text, p_amount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'extensions'
AS $$
  SELECT encode(digest(p_from_account_id::text || '|' || lower(trim(p_to_identifier)) || '|' || round(p_amount, 2)::text, 'sha256'), 'hex');
$$;

-- App: transferencia desde un dispositivo de confianza
CREATE OR REPLACE FUNCTION public.transfer_from_device(p_from_account_id uuid, p_to_identifier character varying, p_amount numeric,
                                                       p_concept character varying, p_payment_method character varying, p_device jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_device_id uuid := public._trusted_device_id(auth.uid(), p_device);
BEGIN
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'DEVICE_NOT_TRUSTED: Este dispositivo no está verificado. Vuelve a iniciar sesión.';
  END IF;
  RETURN public.process_transfer(p_from_account_id, p_to_identifier, p_amount, COALESCE(p_concept, ''),
                                 COALESCE(p_payment_method, 'alias'), v_device_id, NULL);
END;
$$;

-- Web: pedir el código para una transferencia concreta (cuenta, destino y monto)
CREATE OR REPLACE FUNCTION public.request_transfer_code(p_from_account_id uuid, p_to_identifier character varying, p_amount numeric)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  RETURN jsonb_build_object('success', true, 'expires_in_seconds', 300);
END;
$$;

-- Web: transferencia con el código (debe coincidir con cuenta, destino y monto)
CREATE OR REPLACE FUNCTION public.transfer_with_code(p_from_account_id uuid, p_to_identifier character varying, p_amount numeric,
                                                     p_concept character varying, p_payment_method character varying, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_check jsonb;
BEGIN
  v_check := public._otp_verify('transfer', auth.uid(),
                                public._transfer_binding(p_from_account_id, p_to_identifier, p_amount), p_code);
  IF NOT (v_check->>'success')::boolean THEN
    RETURN v_check;
  END IF;
  -- Si la transferencia falla (saldo, límites...) se revierte todo, incluido el uso del código
  RETURN public.process_transfer(p_from_account_id, p_to_identifier, p_amount, COALESCE(p_concept, ''),
                                 COALESCE(p_payment_method, 'alias'), NULL, NULL);
END;
$$;

REVOKE ALL ON FUNCTION public._transfer_binding(uuid, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.transfer_from_device(uuid, character varying, numeric, character varying, character varying, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.request_transfer_code(uuid, character varying, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.transfer_with_code(uuid, character varying, numeric, character varying, character varying, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_from_device(uuid, character varying, numeric, character varying, character varying, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_transfer_code(uuid, character varying, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_with_code(uuid, character varying, numeric, character varying, character varying, text) TO authenticated;

-- process_transfer solo vía las funciones de arriba o service_role (API externa)
REVOKE EXECUTE ON FUNCTION public.process_transfer(uuid, character varying, numeric, character varying, character varying, uuid, inet)
  FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 8. Notificaciones nuevas
-- =============================================================================
INSERT INTO public.notification_types (code, name, description, priority, template_title, template_message, default_enabled, email_template_html)
VALUES
  ('device_verification', 'Verificación de dispositivo', 'Código para iniciar sesión desde un dispositivo nuevo', 1,
   '{"es": "Código para tu nuevo dispositivo", "en": "Code for your new device"}',
   '{"es": "Alguien está intentando iniciar sesión en tu cuenta desde un dispositivo nuevo.", "en": "Someone is trying to sign in from a new device."}',
   true,
   jsonb_build_object('es', '<div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;"><h2 style="color: #1a1a1a;">{{title}}</h2><p>Hola {{first_name}},</p><p>Para iniciar sesión en Magnate desde <strong>{{device_name}}</strong>, ingresa este código:</p><p style="font-size: 32px; font-weight: bold; letter-spacing: 8px; text-align: center; margin: 24px 0;">{{otp_code}}</p><p>El código vence en 10 minutos.</p><p style="color: #b91c1c;"><strong>Si no fuiste tú, no compartas este código y cambia tu PIN desde la app.</strong></p><p style="color: #666; font-size: 12px;">Este es un correo automático, por favor no lo respondas.</p></div>')),
  ('pin_changed', 'PIN cambiado', 'Aviso de cambio de PIN', 1,
   '{"es": "Tu PIN fue cambiado", "en": "Your PIN was changed"}',
   '{"es": "El PIN de tu cuenta Magnate se cambió correctamente.", "en": "Your Magnate PIN was changed."}',
   true,
   jsonb_build_object('es', '<div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;"><h2 style="color: #1a1a1a;">{{title}}</h2><p>Hola {{first_name}},</p><p>{{message}}</p><p style="color: #b91c1c;"><strong>Si no fuiste tú, contacta a soporte de inmediato.</strong></p><p style="color: #666; font-size: 12px;">Este es un correo automático, por favor no lo respondas.</p></div>'))
ON CONFLICT (code) DO NOTHING;

-- =============================================================================
-- 9. handle_new_user: quitar pin_hash de user_metadata al crear el perfil
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_meta jsonb := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
  v_account_type text := COALESCE(NULLIF(v_meta->>'account_type', ''), 'personal');
  v_status text;
  v_company_cuit text;
  v_incorporation_date date;
  v_entity_type text;
  v_legal_name text;
  v_trade_name text;
BEGIN
  RAISE LOG 'Trigger handle_new_user ejecutándose para: % (tipo %)', NEW.email, v_account_type;

  IF v_account_type NOT IN ('personal', 'business') THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT_TYPE: %', v_account_type;
  END IF;

  -- Email verificado con el código del registro (activable desde app_settings)
  IF public.get_setting_bool('require_signup_email_otp', false)
     AND NOT public.signup_email_verified(NEW.email) THEN
    RAISE EXCEPTION 'EMAIL_NOT_VERIFIED: Debes verificar tu email antes de crear la cuenta';
  END IF;

  -- Validar datos de empresa ANTES de crear nada
  IF v_account_type = 'business' THEN
    v_company_cuit := regexp_replace(COALESCE(v_meta->>'company_cuit', ''), '\D', '', 'g');
    v_entity_type  := NULLIF(trim(v_meta->>'legal_entity_type'), '');
    v_legal_name   := NULLIF(trim(v_meta->>'legal_name'), '');
    v_trade_name   := NULLIF(trim(v_meta->>'trade_name'), '');

    IF length(v_company_cuit) <> 11 THEN
      RAISE EXCEPTION 'INVALID_COMPANY_CUIT: El CUIT de la empresa debe tener 11 dígitos';
    END IF;
    IF v_legal_name IS NULL THEN
      RAISE EXCEPTION 'MISSING_LEGAL_NAME: Falta el nombre legal de la empresa';
    END IF;
    IF v_entity_type IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.legal_entity_types WHERE code = v_entity_type AND is_active
    ) THEN
      RAISE EXCEPTION 'INVALID_LEGAL_ENTITY_TYPE: Tipo societario inválido';
    END IF;
    BEGIN
      v_incorporation_date := (v_meta->>'incorporation_date')::date;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'INVALID_INCORPORATION_DATE: Fecha de inscripción inválida';
    END;
    IF v_incorporation_date IS NULL OR v_incorporation_date > CURRENT_DATE THEN
      RAISE EXCEPTION 'INVALID_INCORPORATION_DATE: Fecha de inscripción inválida';
    END IF;
    IF EXISTS (SELECT 1 FROM public.business_profiles WHERE cuit = v_company_cuit) THEN
      RAISE EXCEPTION 'COMPANY_CUIT_EXISTS: Ya existe una cuenta con ese CUIT de empresa';
    END IF;
  END IF;

  v_status := CASE WHEN public.signup_requires_approval(v_account_type) THEN 'pending' ELSE 'verified' END;

  INSERT INTO public.users (
    id, email, first_name, last_name, phone, dni, cuit_cuil,
    pin_hash, verification_status, account_type, status_reason, web_access_enabled,
    zapsign_verification_id, zapsign_contract_url, zapsign_data,
    created_at, updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(v_meta->>'nombres', v_meta->>'first_name', 'FALTA_NOMBRE'),
    COALESCE(v_meta->>'apellidos', v_meta->>'last_name', 'FALTA_APELLIDO'),
    COALESCE(v_meta->>'telefono', v_meta->>'phone', '0000000000'),
    COALESCE(v_meta->>'dni', '00000000'),
    COALESCE(v_meta->>'cuit', v_meta->>'cuit_cuil', '00000000000'),
    COALESCE(v_meta->>'pin_hash', 'NO_HASH_SENT'),
    v_status,
    v_account_type,
    CASE WHEN v_status = 'pending' THEN 'pending_approval' ELSE NULL END,
    false,
    COALESCE(
        v_meta->>'zapsign_verification_id',
        v_meta->>'zapsign_doc_token',
        v_meta->>'zapsign_id'
    ),
    COALESCE(
        v_meta->>'zapsign_contract_url',
        v_meta->>'zapsign_url',
        v_meta->>'zapsign_signed_file'
    ),
    v_meta->'zapsign_data',
    NOW(),
    NOW()
  );

  IF v_account_type = 'business' THEN
    INSERT INTO public.business_profiles (user_id, cuit, incorporation_date, legal_entity_type, legal_name, trade_name)
    VALUES (NEW.id, v_company_cuit, v_incorporation_date, v_entity_type, v_legal_name, v_trade_name);
  END IF;

  -- El hash del PIN ya se guardó en public.users: no debe quedar en user_metadata (viaja en el JWT)
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data - 'pin_hash' WHERE id = NEW.id;

  RAISE LOG 'Usuario creado en public.users: % (tipo %, estado %)', NEW.id, v_account_type, v_status;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'ERROR EN TRIGGER handle_new_user: %', SQLERRM;
    RAISE EXCEPTION 'Error creando perfil de usuario: %', SQLERRM;
END;
$function$;

-- =============================================================================
-- 10. GoTrue vuelve a escribir user_metadata después del INSERT: quitar
--     pin_hash en cada UPDATE de auth.users (en el INSERT se mantiene porque
--     handle_new_user lo necesita para crear el perfil).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.strip_pin_hash_from_auth_metadata()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.raw_user_meta_data ? 'pin_hash' THEN
    NEW.raw_user_meta_data := NEW.raw_user_meta_data - 'pin_hash';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.strip_pin_hash_from_auth_metadata() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS strip_pin_hash_from_metadata ON auth.users;
CREATE TRIGGER strip_pin_hash_from_metadata
  BEFORE UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.strip_pin_hash_from_auth_metadata();

COMMIT;
