-- Entorno de la plataforma (desarrollo / producción) y modo de verificación de identidad.
--
-- app_settings.app_environment: 'development' | 'production'
--   La función "zapsign" elige con esto las credenciales: sandbox en desarrollo,
--   producción en producción (secrets ZAPSIGN_*_SANDBOX / ZAPSIGN_*_PROD de Supabase).
-- app_settings.identity_verification_mode: 'zapsign' | 'simulated'
--   'simulated' da la verificación por hecha sin pasar por ZapSign. Solo se permite en
--   desarrollo: al pasar a producción vuelve sola a 'zapsign'.
--
-- La función "zapsign" deja cada verificación en identity_verifications. En producción el
-- registro exige una verificación real aprobada para ese email; en desarrollo no la exige.

INSERT INTO public.app_settings (key, value, description) VALUES
  ('app_environment', '"development"'::jsonb,
   'Entorno: development (ZapSign sandbox) o production (ZapSign real)'),
  ('identity_verification_mode', '"zapsign"'::jsonb,
   'Verificación de identidad en el registro: zapsign o simulated (solo en development)')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.app_environment()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN (SELECT value #>> '{}' FROM public.app_settings WHERE key = 'app_environment') = 'production'
              THEN 'production' ELSE 'development' END;
$$;

CREATE OR REPLACE FUNCTION public.identity_verification_mode()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN public.app_environment() = 'development'
               AND (SELECT value #>> '{}' FROM public.app_settings WHERE key = 'identity_verification_mode') = 'simulated'
              THEN 'simulated' ELSE 'zapsign' END;
$$;

REVOKE ALL ON FUNCTION public.app_environment() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.identity_verification_mode() FROM PUBLIC, anon, authenticated;

-- Lo que la app necesita saber antes de iniciar sesión (registro)
CREATE OR REPLACE FUNCTION public.get_public_app_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'environment', public.app_environment(),
    'identity_verification', public.identity_verification_mode()
  );
$$;

REVOKE ALL ON FUNCTION public.get_public_app_config() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_app_config() TO anon, authenticated;

-- Valores válidos, y 'simulated' nunca en producción
CREATE OR REPLACE FUNCTION public.guard_environment_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.on_environment_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.key = 'app_environment' AND NEW.value #>> '{}' = 'production' THEN
    UPDATE public.app_settings
       SET value = '"zapsign"'::jsonb, updated_at = now()
     WHERE key = 'identity_verification_mode' AND value #>> '{}' <> 'zapsign';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS guard_environment_settings ON public.app_settings;
CREATE TRIGGER guard_environment_settings
  BEFORE INSERT OR UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_environment_settings();

DROP TRIGGER IF EXISTS on_environment_changed ON public.app_settings;
CREATE TRIGGER on_environment_changed
  AFTER INSERT OR UPDATE ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.on_environment_changed();

-- Verificaciones de identidad (las escribe solo la función "zapsign" con service role)
CREATE TABLE IF NOT EXISTS public.identity_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_token text NOT NULL UNIQUE,
  email text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'production')),
  simulated boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'failed')),
  signed_file_url text,
  biometric jsonb,
  verified_at timestamptz,
  used_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS identity_verifications_email_idx
  ON public.identity_verifications (email, created_at DESC);

ALTER TABLE public.identity_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.identity_verifications FROM anon, authenticated;

DROP POLICY IF EXISTS "Admins can read identity verifications" ON public.identity_verifications;
CREATE POLICY "Admins can read identity verifications" ON public.identity_verifications
  FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON public.identity_verifications TO authenticated;

-- Registro: exige la verificación real en producción y la marca como usada
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
  v_staff_role text;
  v_staff_key text;
  v_doc_token text;
  v_idv public.identity_verifications%ROWTYPE;
BEGIN
  -- Usuario del panel (distribuidor): sin cuenta bancaria, sin DNI ni PIN.
  -- Solo si el servidor registró la invitación en los últimos 10 minutos.
  UPDATE public.staff_invites
     SET consumed_at = now()
   WHERE email = lower(NEW.email)
     AND consumed_at IS NULL
     AND created_at > now() - interval '10 minutes'
  RETURNING role INTO v_staff_role;

  IF v_staff_role = 'distributor' THEN
    -- dni / cuit_cuil son únicos y de 20 caracteres
    v_staff_key := 'S' || substr(replace(NEW.id::text, '-', ''), 1, 19);
    INSERT INTO public.users (
      id, email, first_name, last_name, phone, dni, cuit_cuil, pin_hash,
      verification_status, account_type, role, web_access_enabled, created_at, updated_at
    ) VALUES (
      NEW.id, NEW.email,
      COALESCE(NULLIF(v_meta->>'first_name', ''), 'Distribuidor'),
      COALESCE(NULLIF(v_meta->>'last_name', ''), ''),
      '0000000000', v_staff_key, v_staff_key, 'NO_PIN',
      'verified', 'personal', 'distributor', false, NOW(), NOW()
    );
    RETURN NEW;
  END IF;

  RAISE LOG 'Trigger handle_new_user ejecutándose para: % (tipo %)', NEW.email, v_account_type;

  IF v_account_type NOT IN ('personal', 'business') THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT_TYPE: %', v_account_type;
  END IF;

  IF public.get_setting_bool('require_signup_email_otp', false)
     AND NOT public.signup_email_verified(NEW.email) THEN
    RAISE EXCEPTION 'EMAIL_NOT_VERIFIED: Debes verificar tu email antes de crear la cuenta';
  END IF;

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

  -- Verificación de identidad hecha por la función "zapsign" para este email.
  -- En producción es obligatoria y tiene que ser real; en desarrollo es opcional.
  v_doc_token := COALESCE(
    NULLIF(v_meta->>'zapsign_verification_id', ''),
    NULLIF(v_meta->>'zapsign_doc_token', ''),
    NULLIF(v_meta->>'zapsign_id', '')
  );
  SELECT * INTO v_idv
    FROM public.identity_verifications
   WHERE doc_token = v_doc_token
     AND email = lower(NEW.email)
     AND status = 'verified'
     AND used_by IS NULL
   FOR UPDATE;

  IF public.app_environment() = 'production'
     AND (v_idv.id IS NULL OR v_idv.simulated OR v_idv.environment <> 'production') THEN
    RAISE EXCEPTION 'IDENTITY_NOT_VERIFIED: Falta completar la verificación de identidad';
  END IF;

  v_status := CASE WHEN public.signup_requires_approval(v_account_type) THEN 'pending' ELSE 'verified' END;

  INSERT INTO public.users (
    id, email, first_name, last_name, phone, dni, cuit_cuil,
    pin_hash, verification_status, account_type, status_reason, web_access_enabled,
    zapsign_verification_id, zapsign_contract_url, zapsign_data, zapsign_verified_at,
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
    v_doc_token,
    COALESCE(
        v_meta->>'zapsign_contract_url',
        v_meta->>'zapsign_url',
        v_meta->>'zapsign_signed_file'
    ),
    CASE WHEN v_idv.id IS NULL THEN v_meta->'zapsign_data'
         ELSE COALESCE(v_meta->'zapsign_data', '{}'::jsonb)
              || jsonb_build_object('simulated', v_idv.simulated, 'environment', v_idv.environment) END,
    v_idv.verified_at,
    NOW(),
    NOW()
  );

  IF v_account_type = 'business' THEN
    INSERT INTO public.business_profiles (user_id, cuit, incorporation_date, legal_entity_type, legal_name, trade_name)
    VALUES (NEW.id, v_company_cuit, v_incorporation_date, v_entity_type, v_legal_name, v_trade_name);
  END IF;

  IF v_idv.id IS NOT NULL THEN
    UPDATE public.identity_verifications SET used_by = NEW.id, updated_at = now() WHERE id = v_idv.id;
  END IF;

  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data - 'pin_hash' WHERE id = NEW.id;

  RAISE LOG 'Usuario creado en public.users: % (tipo %, estado %)', NEW.id, v_account_type, v_status;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'ERROR EN TRIGGER handle_new_user: %', SQLERRM;
    RAISE EXCEPTION 'Error creando perfil de usuario: %', SQLERRM;
END;
$function$;
