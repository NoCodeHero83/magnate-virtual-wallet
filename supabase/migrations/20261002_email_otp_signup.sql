-- =============================================================================
-- Verificación de email en el registro, del lado del servidor
-- Fecha: 2026-10-02
--
-- Antes: la app generaba el código de 6 dígitos y lo validaba con
-- supabase.auth.verifyOtp (que nunca existió porque el usuario aún no está
-- creado). Solo funcionaba en APP_ENV=test aceptando el código local.
-- Ahora: el código se genera, guarda (hash bcrypt) y valida en la BD.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. email_otps: cerrar el acceso directo (tenía una política "All" abierta
--    a todo el mundo). Solo se usa a través de las funciones de abajo.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "All" ON public.email_otps;
REVOKE ALL ON public.email_otps FROM anon, authenticated;

ALTER TABLE public.email_otps
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'signup',
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_email_otps_email_created
  ON public.email_otps (lower(email), purpose, created_at DESC);

-- Obligar a que el registro tenga el email verificado por OTP.
-- Arranca en false para no romper builds viejas de la app que no usan estas
-- funciones; activarlo cuando la versión nueva sea obligatoria.
INSERT INTO public.app_settings (key, value, description) VALUES
  ('require_signup_email_otp', 'false'::jsonb,
   'El registro exige haber verificado el email con el código enviado (activar cuando la app nueva sea obligatoria)')
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Solicitar código (anon): genera, guarda el hash y encola el email
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_signup_email_otp(p_email text, p_first_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
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

  RETURN jsonb_build_object('success', true, 'expires_in_seconds', extract(epoch FROM v_ttl)::int);
END;
$$;
REVOKE ALL ON FUNCTION public.request_signup_email_otp(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_signup_email_otp(text, text) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Verificar código (anon): máximo 5 intentos por código
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_signup_email_otp(p_email text, p_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_email text := lower(trim(COALESCE(p_email, '')));
  v_otp public.email_otps%ROWTYPE;
BEGIN
  SELECT * INTO v_otp FROM public.email_otps
   WHERE lower(email) = v_email AND purpose = 'signup' AND NOT used
   ORDER BY created_at DESC
   LIMIT 1
   FOR UPDATE;

  IF NOT FOUND OR v_otp.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'CODE_EXPIRED');
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
  RETURN jsonb_build_object('success', false, 'error', 'INVALID_CODE',
                            'attempts_left', greatest(0, 4 - v_otp.attempts));
END;
$$;
REVOKE ALL ON FUNCTION public.verify_signup_email_otp(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.verify_signup_email_otp(text, text) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. handle_new_user: exigir email verificado (solo si el switch está activo)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.signup_email_verified(p_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.email_otps
     WHERE lower(email) = lower(trim(p_email)) AND purpose = 'signup'
       AND verified_at IS NOT NULL AND verified_at > now() - interval '2 hours'
  );
$$;
REVOKE ALL ON FUNCTION public.signup_email_verified(text) FROM PUBLIC, anon, authenticated;

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

  RAISE LOG 'Usuario creado en public.users: % (tipo %, estado %)', NEW.id, v_account_type, v_status;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'ERROR EN TRIGGER handle_new_user: %', SQLERRM;
    RAISE EXCEPTION 'Error creando perfil de usuario: %', SQLERRM;
END;
$function$;

COMMIT;
