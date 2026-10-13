-- =============================================================================
-- Auditoría (2026-10-13): credenciales de la API externa
--
-- * La contraseña API se guardaba como SHA-256 sin sal y api-auth no limitaba los
--   intentos (el client_id es predecible: mag_<8 hex del uid>_<sufijo>).
--   Ahora: bcrypt, 5 intentos fallidos cada 15 minutos por client_id y un único
--   error. Los hashes SHA-256 existentes se pasan a bcrypt en el próximo login.
-- * credentials_changed_at: los tokens emitidos antes de habilitar el acceso o de
--   cambiar la contraseña dejan de valer (antes duraban 30 días igual).
-- =============================================================================

ALTER TABLE public.api_access ADD COLUMN IF NOT EXISTS credentials_changed_at timestamptz;
-- Los tokens emitidos hasta hoy (con el hash viejo) se invalidan
UPDATE public.api_access SET credentials_changed_at = now() WHERE credentials_changed_at IS NULL;

CREATE TABLE IF NOT EXISTS public.api_auth_attempts (
  client_id text PRIMARY KEY,
  failed_count int NOT NULL DEFAULT 0,
  last_failed_at timestamptz,
  locked_until timestamptz
);
ALTER TABLE public.api_auth_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_auth_attempts FROM anon, authenticated;

-- Hash para la contraseña API (lo usa api-setup)
CREATE OR REPLACE FUNCTION public._hash_api_password(p_password text)
RETURNS text
LANGUAGE sql
VOLATILE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
  SELECT crypt(p_password, gen_salt('bf', 10));
$$;
REVOKE ALL ON FUNCTION public._hash_api_password(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._hash_api_password(text) TO service_role;

-- Validación de client_id + contraseña (la usa api-auth)
CREATE OR REPLACE FUNCTION public.api_auth_check(p_client_id text, p_password text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_max_attempts constant int := 5;
  v_window constant interval := interval '15 minutes';
  v_lock constant interval := interval '15 minutes';
  v_client text := trim(COALESCE(p_client_id, ''));
  v_access public.api_access%ROWTYPE;
  v_attempts public.api_auth_attempts%ROWTYPE;
  v_hash text;
  v_ok boolean := false;
  v_failed int;
BEGIN
  IF v_client = '' OR COALESCE(p_password, '') = '' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_CREDENTIALS');
  END IF;

  -- El límite es por client_id, exista o no (no revela cuáles existen)
  SELECT * INTO v_attempts FROM public.api_auth_attempts WHERE client_id = v_client FOR UPDATE;
  IF v_attempts.locked_until IS NOT NULL AND v_attempts.locked_until > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'LOCKED',
      'retry_after_seconds', ceil(extract(epoch FROM v_attempts.locked_until - now()))::int);
  END IF;

  SELECT * INTO v_access FROM public.api_access WHERE client_id = v_client;
  v_hash := COALESCE(v_access.api_password_hash, '');

  IF v_hash ~ '^\$2[aby]\$\d\d\$.{53}$' THEN
    v_hash := '$2a$' || substr(v_hash, 5);
    v_ok := crypt(p_password, v_hash) = v_hash;
  ELSIF v_hash ~ '^[0-9a-f]{64}$' THEN
    -- Hash viejo (SHA-256 sin sal): si coincide, se reemplaza por bcrypt
    v_ok := encode(digest(p_password, 'sha256'), 'hex') = v_hash;
    IF v_ok THEN
      UPDATE public.api_access SET api_password_hash = crypt(p_password, gen_salt('bf', 10)) WHERE id = v_access.id;
    END IF;
  END IF;

  IF v_ok THEN
    DELETE FROM public.api_auth_attempts WHERE client_id = v_client;
    IF NOT v_access.is_enabled THEN
      RETURN jsonb_build_object('success', false, 'error', 'DISABLED');
    END IF;
    RETURN jsonb_build_object(
      'success', true,
      'api_access_id', v_access.id,
      'user_id', v_access.user_id,
      'client_id', v_access.client_id,
      'allowed_ips', to_jsonb(COALESCE(v_access.allowed_ips, ARRAY[]::text[]))
    );
  END IF;

  v_failed := CASE
    WHEN v_attempts.client_id IS NULL OR v_attempts.last_failed_at IS NULL
         OR v_attempts.last_failed_at < now() - v_window THEN 1
    ELSE v_attempts.failed_count + 1
  END;
  INSERT INTO public.api_auth_attempts (client_id, failed_count, last_failed_at, locked_until)
  VALUES (v_client, v_failed, now(), NULL)
  ON CONFLICT (client_id) DO UPDATE
    SET failed_count = EXCLUDED.failed_count, last_failed_at = now(), locked_until = NULL;

  IF v_failed >= v_max_attempts THEN
    UPDATE public.api_auth_attempts SET failed_count = 0, locked_until = now() + v_lock WHERE client_id = v_client;
    RETURN jsonb_build_object('success', false, 'error', 'LOCKED', 'retry_after_seconds', extract(epoch FROM v_lock)::int);
  END IF;
  RETURN jsonb_build_object('success', false, 'error', 'INVALID_CREDENTIALS');
END;
$$;
REVOKE ALL ON FUNCTION public.api_auth_check(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_auth_check(text, text) TO service_role;
