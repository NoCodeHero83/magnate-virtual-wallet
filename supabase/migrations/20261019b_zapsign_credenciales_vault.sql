-- Credenciales de ZapSign en Supabase Vault (Dashboard → Project Settings → Vault).
-- La función "zapsign" toma las del entorno activo (app_settings.app_environment):
--   development: zapsign_api_key_sandbox, zapsign_template_id_sandbox
--   production:  zapsign_api_key_prod, zapsign_template_id_prod,
--                zapsign_selfie_validation_type_prod (opcional: 'liveness-document-match' | 'identity-verification-global')
-- Para pasar a producción: cargar los secretos _prod en Vault y poner app_environment = "production".

CREATE OR REPLACE FUNCTION public.zapsign_runtime_config()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_env text := public.app_environment();
  v_suffix text := CASE WHEN v_env = 'production' THEN '_prod' ELSE '_sandbox' END;
BEGIN
  RETURN jsonb_build_object(
    'environment', v_env,
    'simulated', public.identity_verification_mode() = 'simulated',
    'api_key', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapsign_api_key' || v_suffix),
    'template_id', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapsign_template_id' || v_suffix),
    'selfie_validation_type', CASE WHEN v_env = 'production'
      THEN (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'zapsign_selfie_validation_type_prod') END
  );
END;
$$;

-- Solo la edge function (service role) puede leer las credenciales
REVOKE ALL ON FUNCTION public.zapsign_runtime_config() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.zapsign_runtime_config() TO service_role;
