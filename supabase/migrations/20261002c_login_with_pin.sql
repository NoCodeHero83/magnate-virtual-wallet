-- =============================================================================
-- Login con PIN validado en el servidor
-- Fecha: 2026-10-02
--
-- Antes: la app llamaba get_user_login_data (sin sesión) y recibía pin_hash y
-- auto_password_encrypted de CUALQUIER email; el PIN se comparaba en el teléfono
-- y los intentos se contaban en el teléfono. Además suspend_user_account podía
-- llamarse sin sesión con cualquier id.
-- Ahora: login_with_pin compara el PIN en la BD, cuenta los intentos en la BD
-- (3 fallidos = suspensión) y solo devuelve la credencial si el PIN es correcto.
-- El resto del flujo (signIn con la contraseña automática, verificación de
-- dispositivo) no cambia.
-- =============================================================================

BEGIN;

-- Intentos fallidos de PIN (sin acceso desde la API)
CREATE TABLE IF NOT EXISTS public.pin_login_attempts (
  user_id         uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  failed_count    integer NOT NULL DEFAULT 0,
  last_failed_at  timestamptz
);
ALTER TABLE public.pin_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pin_login_attempts FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.login_with_pin(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_max_attempts constant int := 3;
  v_user record;
  v_hash text;
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
    INSERT INTO public.pin_login_attempts AS a (user_id, failed_count, last_failed_at)
    VALUES (v_user.id, 1, now())
    ON CONFLICT (user_id) DO UPDATE
      SET failed_count = a.failed_count + 1, last_failed_at = now()
    RETURNING failed_count INTO v_failed;

    IF v_failed >= v_max_attempts THEN
      UPDATE public.users
         SET verification_status = 'suspended', status_reason = 'pin_attempts_exceeded'
       WHERE id = v_user.id;
      DELETE FROM public.pin_login_attempts WHERE user_id = v_user.id;
      RETURN jsonb_build_object('success', false, 'error', 'PIN_LOCKED');
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
$$;
REVOKE ALL ON FUNCTION public.login_with_pin(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.login_with_pin(text, text) TO anon, authenticated;

-- Al quitar una suspensión desde el admin, reiniciar el contador de intentos
CREATE OR REPLACE FUNCTION public.reset_pin_attempts_on_unsuspend()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.verification_status = 'suspended' AND NEW.verification_status <> 'suspended' THEN
    DELETE FROM public.pin_login_attempts WHERE user_id = NEW.id;
    IF NEW.status_reason = 'pin_attempts_exceeded' THEN
      NEW.status_reason := NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_reset_pin_attempts_on_unsuspend ON public.users;
CREATE TRIGGER trigger_reset_pin_attempts_on_unsuspend
  BEFORE UPDATE OF verification_status ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.reset_pin_attempts_on_unsuspend();

-- Cerrar las funciones viejas a la API pública (solo service_role / uso interno)
REVOKE EXECUTE ON FUNCTION public.get_user_login_data(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.suspend_user_account(uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
