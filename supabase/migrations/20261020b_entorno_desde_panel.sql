-- Entorno (desarrollo / producción) y verificación de identidad desde Configuración del panel.
-- Los valores siguen en app_settings (app_environment, identity_verification_mode) y los
-- triggers de 20261019 siguen valiendo: 'simulated' nunca en producción.

-- Estado actual y si las credenciales de cada entorno están cargadas en Vault (sin mostrarlas)
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
    'sandbox_configured', v_names @> ARRAY['zapsign_api_key_sandbox', 'zapsign_template_id_sandbox'],
    'production_configured', v_names @> ARRAY['zapsign_api_key_prod', 'zapsign_template_id_prod'],
    'production_biometric', 'zapsign_selfie_validation_type_prod' = ANY(v_names),
    'updated_at', (SELECT max(updated_at) FROM public.app_settings
                    WHERE key IN ('app_environment', 'identity_verification_mode'))
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admin_environment_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_environment_settings() TO authenticated;

-- Cambia el entorno y el modo de verificación. Para pasar a producción tienen que estar
-- cargadas las credenciales de producción: sin ellas nadie podría registrarse.
CREATE OR REPLACE FUNCTION public.admin_set_environment_settings(p_environment text, p_identity_verification text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  IF p_environment = 'production' AND NOT (public.admin_environment_settings()->>'production_configured')::boolean THEN
    RAISE EXCEPTION 'PROD_CREDENTIALS_MISSING: Faltan las credenciales de ZapSign de producción en Supabase Vault (zapsign_api_key_prod y zapsign_template_id_prod)';
  END IF;

  -- Primero el modo (si se vuelve a ZapSign) y después el entorno: así el trigger nunca ve
  -- 'simulated' con producción. Al pasar a producción, el trigger además fuerza 'zapsign'.
  IF p_identity_verification = 'zapsign' THEN
    UPDATE public.app_settings SET value = to_jsonb(p_identity_verification), updated_at = now(), updated_by = auth.uid()
     WHERE key = 'identity_verification_mode' AND value <> to_jsonb(p_identity_verification);
  END IF;
  UPDATE public.app_settings SET value = to_jsonb(p_environment), updated_at = now(), updated_by = auth.uid()
   WHERE key = 'app_environment' AND value <> to_jsonb(p_environment);
  IF p_identity_verification = 'simulated' THEN
    UPDATE public.app_settings SET value = to_jsonb(p_identity_verification), updated_at = now(), updated_by = auth.uid()
     WHERE key = 'identity_verification_mode' AND value <> to_jsonb(p_identity_verification);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_environment_settings(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_environment_settings(text, text) TO authenticated;
