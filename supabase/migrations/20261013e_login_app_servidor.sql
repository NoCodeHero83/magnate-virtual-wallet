-- =============================================================================
-- Auditoría (2026-10-13): login de la app y datos sensibles de users
--
-- * login_with_pin y verify_device_login solo los llama la edge function app-login
--   (service_role), que crea la sesión en el servidor. Antes devolvían a la app la
--   contraseña de Supabase Auth (auto_password, apenas ofuscada).
-- * user_auth_credentials: el usuario ya no puede leer ni cambiar su credencial
--   (con una sesión robada se obtenía una contraseña permanente).
-- * users: pin_hash y web_password_hash ya no se pueden leer desde la API (con una
--   sesión robada se podía sacar el hash del PIN y probar los 10^6 PIN offline).
--   La lectura queda por columnas: si se agrega una columna a users que la app deba
--   leer, hay que sumarla al GRANT de abajo.
-- * TRUNCATE no corresponde a ningún rol de la API.
-- =============================================================================

-- 1. Login solo por la edge function -------------------------------------------
REVOKE ALL ON FUNCTION public.login_with_pin(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.login_with_pin(text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.verify_device_login(text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_device_login(text, jsonb, text) TO service_role;

-- 2. Credencial interna: solo se crea en el registro ----------------------------
DROP POLICY IF EXISTS "Users can view own credentials" ON public.user_auth_credentials;
DROP POLICY IF EXISTS "Users can update own credentials" ON public.user_auth_credentials;
REVOKE ALL ON public.user_auth_credentials FROM anon;
REVOKE SELECT, UPDATE, DELETE, TRUNCATE ON public.user_auth_credentials FROM authenticated;

-- 3. users: lectura por columnas (sin hashes) --------------------------------------
REVOKE ALL ON public.users FROM anon;
REVOKE SELECT ON public.users FROM authenticated;
GRANT SELECT (
  id, first_name, last_name, email, phone, dni, cuit_cuil,
  web_access_enabled, web_access_enabled_at, verification_status,
  zapsign_verification_id, zapsign_verified_at, zapsign_data, created_at, updated_at,
  photo_url, role, zapsign_contract_url, account_type, status_reason,
  reviewed_by, reviewed_at, pin_upgrade_required
) ON public.users TO authenticated;

-- 4. TRUNCATE no lo usa ningún cliente ----------------------------------------------
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
