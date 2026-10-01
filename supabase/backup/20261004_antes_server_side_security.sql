-- Respaldo antes de 20261004_server_side_security.sql
-- user_devices: authenticated tenía INSERT/UPDATE completos; process_transfer era ejecutable por authenticated

CREATE OR REPLACE FUNCTION public.claim_onesignal_device(p_player_id text, p_device_id text, p_user_id uuid, p_platform text, p_push_enabled boolean, p_device_os_version text, p_app_version text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    -- 1. Libera (nullify) cualquier dispositivo que estuviera usando este player_id
    UPDATE user_devices
    SET player_id = NULL
    WHERE player_id = p_player_id
      AND (user_id != p_user_id OR device_id != p_device_id);

    -- 2. Actualiza o Inserta el dispositivo para el usuario actual
    INSERT INTO user_devices (
        user_id,
        device_id,
        player_id,
        platform,
        push_enabled,
        device_os_version,
        app_version,
        is_active,
        last_active_at
    )
    VALUES (
        p_user_id,
        p_device_id,
        p_player_id,
        p_platform,
        p_push_enabled,
        p_device_os_version,
        p_app_version,
        TRUE,
        now()
    )
    ON CONFLICT (user_id, device_id)
    DO UPDATE SET
        player_id = EXCLUDED.player_id,
        platform = EXCLUDED.platform,
        push_enabled = EXCLUDED.push_enabled,
        device_os_version = EXCLUDED.device_os_version,
        app_version = EXCLUDED.app_version,
        is_active = TRUE,
        last_active_at = now();
END;
$function$
;

CREATE OR REPLACE FUNCTION public.login_with_pin(p_email text, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_max_attempts constant int := 3;
  v_window constant interval := interval '15 minutes';
  v_lock constant interval := interval '15 minutes';
  v_user record;
  v_hash text;
  v_attempts public.pin_login_attempts%ROWTYPE;
  v_failed int;
BEGIN
  SELECT u.id, u.pin_hash, u.verification_status, u.account_type, u.status_reason,
         c.auto_password_encrypted
    INTO v_user
    FROM public.users u
    LEFT JOIN public.user_auth_credentials c ON c.user_id = u.id
   WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;

  SELECT * INTO v_attempts FROM public.pin_login_attempts WHERE user_id = v_user.id FOR UPDATE;

  IF v_attempts.locked_until IS NOT NULL AND v_attempts.locked_until > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN_LOCKED',
      'retry_after_seconds', ceil(extract(epoch FROM v_attempts.locked_until - now()))::int);
  END IF;

  IF v_user.verification_status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'SUSPENDED');
  END IF;

  -- bcryptjs genera $2b$; pgcrypto solo acepta $2a$ (mismo algoritmo)
  v_hash := COALESCE(v_user.pin_hash, '');
  IF v_hash !~ '^\$2[aby]\$\d\d\$.{53}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'CORRUPT_CREDENTIALS');
  END IF;
  v_hash := '$2a$' || substr(v_hash, 5);

  IF crypt(COALESCE(p_pin, ''), v_hash) <> v_hash THEN
    -- Los fallos viejos (fuera de la ventana) no cuentan
    v_failed := CASE
      WHEN v_attempts.user_id IS NULL OR v_attempts.last_failed_at IS NULL
           OR v_attempts.last_failed_at < now() - v_window THEN 1
      ELSE v_attempts.failed_count + 1
    END;

    INSERT INTO public.pin_login_attempts (user_id, failed_count, last_failed_at, locked_until)
    VALUES (v_user.id, v_failed, now(), NULL)
    ON CONFLICT (user_id) DO UPDATE
      SET failed_count = EXCLUDED.failed_count, last_failed_at = now(), locked_until = NULL;

    IF v_failed >= v_max_attempts THEN
      UPDATE public.pin_login_attempts
         SET failed_count = 0, locked_until = now() + v_lock
       WHERE user_id = v_user.id;
      RETURN jsonb_build_object('success', false, 'error', 'PIN_LOCKED',
        'retry_after_seconds', extract(epoch FROM v_lock)::int);
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PIN',
                              'attempts_left', v_max_attempts - v_failed);
  END IF;

  -- PIN correcto
  DELETE FROM public.pin_login_attempts WHERE user_id = v_user.id;

  IF v_user.verification_status = 'rejected' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REJECTED', 'status_reason', v_user.status_reason);
  END IF;

  IF v_user.verification_status NOT IN ('verified', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_VERIFIED');
  END IF;

  IF v_user.auto_password_encrypted IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'MISSING_CREDENTIALS');
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_user.id,
    'verification_status', v_user.verification_status,
    'account_type', v_user.account_type,
    'auto_password_encrypted', v_user.auto_password_encrypted
  );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.protect_user_sensitive_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Solo aplica a llamadas directas desde la API (roles anon / authenticated).
  -- Las funciones SECURITY DEFINER y el service_role no pasan por aquí.
  IF current_user IN ('anon', 'authenticated') AND NOT public.is_admin() THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
       OR NEW.account_type IS DISTINCT FROM OLD.account_type
       OR NEW.status_reason IS DISTINCT FROM OLD.status_reason
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
      RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

-- user_devices policies/grants: Users can delete own devices DELETE, Users can view own devices SELECT, Users can insert own devices INSERT, Users can update own devices UPDATE
