-- =============================================================================
-- Persona Jurídica + aprobación de cuentas por administrador
-- Fecha: 2026-10-01
-- Respaldo de las funciones previas: supabase/backup/20261001_funciones_antes_persona_juridica.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. users: tipo de cuenta, motivo de estado y auditoría de revisión
-- -----------------------------------------------------------------------------
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'personal',
  ADD COLUMN IF NOT EXISTS status_reason text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_account_type_check;
ALTER TABLE public.users ADD CONSTRAINT users_account_type_check
  CHECK (account_type IN ('personal', 'business'));

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_verification_status_check;
ALTER TABLE public.users ADD CONSTRAINT users_verification_status_check
  CHECK (verification_status IN ('pending', 'verified', 'rejected', 'suspended'));

CREATE INDEX IF NOT EXISTS idx_users_account_type ON public.users(account_type);
CREATE INDEX IF NOT EXISTS idx_users_verification_status ON public.users(verification_status);

-- -----------------------------------------------------------------------------
-- 2. Catálogo de tipos societarios
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legal_entity_types (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.legal_entity_types (code, name, sort_order) VALUES
  ('SA',          'Sociedad Anónima (SA)',                      10),
  ('SRL',         'Sociedad de Responsabilidad Limitada (SRL)', 20),
  ('SAS',         'Sociedad por Acciones Simplificada (SAS)',   30),
  ('SC',          'Sociedad Colectiva',                         40),
  ('SCS',         'Sociedad en Comandita Simple',               50),
  ('SCA',         'Sociedad en Comandita por Acciones',         60),
  ('COOPERATIVA', 'Cooperativa',                                70),
  ('ASOC_CIVIL',  'Asociación Civil',                           80),
  ('FUNDACION',   'Fundación',                                  90),
  ('OTRA',        'Otra',                                      100)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.legal_entity_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read legal entity types" ON public.legal_entity_types;
CREATE POLICY "Anyone can read legal entity types" ON public.legal_entity_types
  FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "Admins manage legal entity types" ON public.legal_entity_types;
CREATE POLICY "Admins manage legal entity types" ON public.legal_entity_types
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- -----------------------------------------------------------------------------
-- 3. Datos de la empresa (1:1 con users cuando account_type = 'business')
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.business_profiles (
  user_id             uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  cuit                varchar(11) NOT NULL UNIQUE CHECK (cuit ~ '^\d{11}$'),
  incorporation_date  date NOT NULL,
  legal_entity_type   text NOT NULL REFERENCES public.legal_entity_types(code),
  legal_name          text NOT NULL CHECK (length(trim(legal_name)) > 0),
  trade_name          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trigger_update_business_profiles_timestamp ON public.business_profiles;
CREATE TRIGGER trigger_update_business_profiles_timestamp
  BEFORE UPDATE ON public.business_profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.business_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own business profile" ON public.business_profiles;
CREATE POLICY "Users can view own business profile" ON public.business_profiles
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "Admins can view all business profiles" ON public.business_profiles;
CREATE POLICY "Admins can view all business profiles" ON public.business_profiles
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Admins can update business profiles" ON public.business_profiles;
CREATE POLICY "Admins can update business profiles" ON public.business_profiles
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
-- Los INSERT los hace únicamente el trigger handle_new_user (SECURITY DEFINER).

-- -----------------------------------------------------------------------------
-- 4. Configuración general (clave/valor). NO guardar secretos aquí.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.app_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES public.users(id) ON DELETE SET NULL
);

INSERT INTO public.app_settings (key, value, description) VALUES
  ('require_approval_business', 'true'::jsonb,  'Las cuentas de Persona Jurídica requieren aprobación de un administrador'),
  ('require_approval_personal', 'false'::jsonb, 'Las cuentas de Persona Física requieren aprobación de un administrador')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can read app settings" ON public.app_settings;
CREATE POLICY "Admins can read app settings" ON public.app_settings
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Admins can update app settings" ON public.app_settings;
CREATE POLICY "Admins can update app settings" ON public.app_settings
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Lectura de un booleano de configuración (uso interno)
CREATE OR REPLACE FUNCTION public.get_setting_bool(p_key text, p_default boolean DEFAULT false)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::boolean FROM public.app_settings WHERE key = p_key), p_default);
$$;
REVOKE ALL ON FUNCTION public.get_setting_bool(text, boolean) FROM PUBLIC, anon, authenticated;

-- Pública: la app la usa antes del registro para avisar si la cuenta quedará en revisión
CREATE OR REPLACE FUNCTION public.signup_requires_approval(p_account_type text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN p_account_type = 'business'
              THEN public.get_setting_bool('require_approval_business', true)
              ELSE public.get_setting_bool('require_approval_personal', false) END;
$$;
GRANT EXECUTE ON FUNCTION public.signup_requires_approval(text) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Historial de revisiones (auditoría para KYC/KYB)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.account_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  decision         text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  previous_status  text,
  reason           text,
  reviewed_by      uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_reviews_user ON public.account_reviews(user_id, created_at DESC);

ALTER TABLE public.account_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins can read account reviews" ON public.account_reviews;
CREATE POLICY "Admins can read account reviews" ON public.account_reviews
  FOR SELECT TO authenticated USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 6. Protección: un usuario NO puede cambiar su propio rol / estado / tipo
--    (antes cualquier usuario autenticado podía hacerse admin o auto-aprobarse)
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER a propósito: current_user debe ser el rol real que hace el UPDATE.
-- Directo desde la API = 'authenticated'; dentro de una función SECURITY DEFINER = su dueño.
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
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
      RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_protect_user_sensitive_columns ON public.users;
CREATE TRIGGER trigger_protect_user_sensitive_columns
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.protect_user_sensitive_columns();

-- -----------------------------------------------------------------------------
-- 7. Registro: handle_new_user (crea public.users + business_profiles)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 8. Cuenta bancaria: si el usuario queda pendiente, la cuenta nace bloqueada
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_create_account_on_user_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  v_result := public.create_user_bank_account(NEW.id);

  IF NEW.verification_status = 'pending' THEN
    UPDATE public.accounts
       SET status = 'blocked', status_reason = 'pending_approval'
     WHERE user_id = NEW.id;
  END IF;

  RAISE NOTICE 'Cuenta creada automáticamente para usuario %: %', NEW.id, v_result;
  RETURN NEW;
END;
$function$;

-- -----------------------------------------------------------------------------
-- 9. Aprobación / rechazo por administrador
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_review_user(p_user_id uuid, p_decision text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_prev_status text;
  v_new_status text;
  v_reason text := NULLIF(trim(COALESCE(p_reason, '')), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Solo un administrador puede revisar cuentas';
  END IF;

  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'INVALID_DECISION: %', p_decision;
  END IF;

  SELECT verification_status INTO v_prev_status
    FROM public.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND: Usuario no encontrado';
  END IF;

  IF p_decision = 'approve' THEN
    IF v_prev_status NOT IN ('pending', 'rejected') THEN
      RAISE EXCEPTION 'INVALID_STATE: Solo se pueden aprobar cuentas pendientes o rechazadas (estado actual: %)', v_prev_status;
    END IF;
    v_new_status := 'verified';
  ELSE
    IF v_prev_status <> 'pending' THEN
      RAISE EXCEPTION 'INVALID_STATE: Solo se pueden rechazar cuentas pendientes (estado actual: %)', v_prev_status;
    END IF;
    IF v_reason IS NULL THEN
      RAISE EXCEPTION 'REASON_REQUIRED: Indica el motivo del rechazo';
    END IF;
    v_new_status := 'rejected';
  END IF;

  UPDATE public.users
     SET verification_status = v_new_status,
         status_reason = CASE WHEN v_new_status = 'rejected' THEN v_reason ELSE NULL END,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = p_user_id;

  IF v_new_status = 'verified' THEN
    UPDATE public.accounts
       SET status = 'active', status_reason = NULL
     WHERE user_id = p_user_id
       AND status = 'blocked'
       AND status_reason IN ('pending_approval', 'account_rejected');
  ELSE
    UPDATE public.accounts
       SET status_reason = 'account_rejected'
     WHERE user_id = p_user_id
       AND status = 'blocked'
       AND status_reason = 'pending_approval';
  END IF;

  INSERT INTO public.account_reviews (user_id, decision, previous_status, reason, reviewed_by)
  VALUES (p_user_id,
          CASE WHEN v_new_status = 'verified' THEN 'approved' ELSE 'rejected' END,
          v_prev_status, v_reason, auth.uid());

  -- Notificar por email (si falla el encolado no se revierte la revisión)
  BEGIN
    PERFORM public.enqueue_notification(
      p_user_id,
      CASE WHEN v_new_status = 'verified' THEN 'account_approved' ELSE 'account_rejected' END,
      jsonb_build_object('reason', COALESCE(v_reason, ''))
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'No se pudo encolar la notificación de revisión: %', SQLERRM;
  END;

  RETURN jsonb_build_object('success', true, 'user_id', p_user_id,
                            'previous_status', v_prev_status, 'status', v_new_status);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_user(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_user(uuid, text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 10. Notificaciones de aprobación / rechazo
-- -----------------------------------------------------------------------------
INSERT INTO public.notification_types (code, name, description, priority, template_title, template_message, default_enabled, email_template_html)
VALUES
  ('account_approved', 'Cuenta Aprobada', 'La cuenta fue aprobada por un administrador', 1,
   '{"es": "¡Tu cuenta fue aprobada!", "en": "Your account was approved!"}',
   '{"es": "Ya puedes operar con normalidad en Magnate.", "en": "You can now use Magnate normally."}',
   true,
   jsonb_build_object('es', '<div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;"><h2 style="color: #1a1a1a;">{{title}}</h2><p>Hola {{first_name}},</p><p>Revisamos tus datos y tu cuenta ya está activa. {{message}}</p><p style="color: #666; font-size: 12px;">Este es un correo automático, por favor no lo respondas.</p></div>')),
  ('account_rejected', 'Cuenta Rechazada', 'La cuenta fue rechazada por un administrador', 1,
   '{"es": "No pudimos aprobar tu cuenta", "en": "We could not approve your account"}',
   '{"es": "Revisamos tus datos y no pudimos aprobar tu cuenta.", "en": "We reviewed your data and could not approve your account."}',
   true,
   jsonb_build_object('es', '<div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;"><h2 style="color: #1a1a1a;">{{title}}</h2><p>Hola {{first_name}},</p><p>{{message}}</p><div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;"><p><strong>Motivo:</strong> {{reason}}</p></div><p>Si crees que se trata de un error, contáctanos desde la sección de soporte.</p><p style="color: #666; font-size: 12px;">Este es un correo automático, por favor no lo respondas.</p></div>'))
ON CONFLICT (code) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 11. get_user_login_data: devolver tipo de cuenta y motivo de estado
-- -----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_user_login_data(text);
CREATE FUNCTION public.get_user_login_data(email_input text)
 RETURNS TABLE(id uuid, email text, pin_hash text, verification_status text, web_access_enabled boolean,
               web_password_hash text, auto_password_encrypted text, first_name text,
               account_type text, status_reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    u.id,
    u.email::text,
    u.pin_hash::text,
    u.verification_status::text,
    u.web_access_enabled,
    u.web_password_hash::text,
    c.auto_password_encrypted::text,
    u.first_name::text,
    u.account_type,
    u.status_reason
  FROM public.users u
  LEFT JOIN public.user_auth_credentials c ON c.user_id = u.id
  WHERE u.email = email_input;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.get_user_login_data(text) TO anon, authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 12. process_transfer: no tratar cuentas internas no activas como externas
--     (antes: transferir a una cuenta bloqueada/pendiente la marcaba "externa")
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_transfer(p_from_account_id uuid, p_to_identifier character varying, p_amount numeric, p_concept character varying DEFAULT ''::character varying, p_payment_method character varying DEFAULT 'cbu'::character varying, p_device_id uuid DEFAULT NULL::uuid, p_ip_address inet DEFAULT NULL::inet)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_transaction_id UUID;
  v_to_account_id UUID;
  v_from_balance DECIMAL;
  v_monthly_limit DECIMAL;
  v_monthly_spent DECIMAL;
  v_daily_limit DECIMAL;
  v_daily_spent DECIMAL;
  v_per_transaction_limit DECIMAL;
  v_from_status VARCHAR;
  v_to_status VARCHAR;
  v_transfer_out_type_id UUID;
  v_transfer_in_type_id UUID;
  v_external_holder VARCHAR;
  v_is_external BOOLEAN := false;
  v_commission DECIMAL := 0.00;
  v_net_amount DECIMAL;
  v_reference_number VARCHAR;
  v_result JSONB;
  v_user_id UUID;
BEGIN
  -- ============================================================================
  -- 1. VALIDAR QUE EL USUARIO SEA DUEÑO DE LA CUENTA ORIGEN
  -- ============================================================================
  SELECT user_id INTO v_user_id
  FROM accounts
  WHERE id = p_from_account_id;
  
  IF v_user_id != auth.uid() THEN
    RAISE EXCEPTION 'UNAUTHORIZED: No tienes permisos para usar esta cuenta';
  END IF;
  
  -- ============================================================================
  -- 2. Obtener IDs de tipos de transacción
  -- ============================================================================
  SELECT id INTO v_transfer_out_type_id FROM transaction_types WHERE code = 'transfer_out';
  SELECT id INTO v_transfer_in_type_id FROM transaction_types WHERE code = 'transfer_in';
  
  IF v_transfer_out_type_id IS NULL OR v_transfer_in_type_id IS NULL THEN
    RAISE EXCEPTION 'TRANSACTION_TYPES_NOT_FOUND: Tipos de transacción no configurados';
  END IF;
  
  -- ============================================================================
  -- 3. Validar cuenta origen con bloqueo
  -- ============================================================================
  SELECT balance, status INTO v_from_balance, v_from_status 
  FROM accounts 
  WHERE id = p_from_account_id 
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_FOUND: Cuenta de origen no encontrada';
  END IF;
  
  IF v_from_status != 'active' THEN
    RAISE EXCEPTION 'ACCOUNT_NOT_ACTIVE: Cuenta de origen no está activa (%)' , v_from_status;
  END IF;
  
  -- ============================================================================
  -- 4. Validar monto mínimo
  -- ============================================================================
  IF p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: El monto debe ser mayor a 0';
  END IF;
  
  -- ============================================================================
  -- 5. Buscar cuenta destino (por alias, CVU o CBU)
  -- ============================================================================
  SELECT id, status INTO v_to_account_id, v_to_status
  FROM accounts 
  WHERE 
    (LOWER(alias) = LOWER(p_to_identifier) OR cvu = p_to_identifier OR cbu = p_to_identifier)
    AND status = 'active'
  FOR UPDATE;
  
  -- Si no se encuentra una cuenta activa, verificar si existe una cuenta interna
  -- no operativa (pendiente de aprobación, bloqueada, etc.) para no tratarla como externa
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM accounts
      WHERE (LOWER(alias) = LOWER(p_to_identifier) OR cvu = p_to_identifier OR cbu = p_to_identifier)
    ) THEN
      RAISE EXCEPTION 'DESTINATION_NOT_ACTIVE: La cuenta destino no está habilitada para recibir transferencias';
    END IF;
    v_is_external := true;
    v_external_holder := 'Cuenta Externa';
    v_commission := 0.00;
  ELSE
    v_commission := 0.00;
  END IF;
  
  v_net_amount := p_amount - v_commission;
  
  -- ============================================================================
  -- 6. Validar que no se transfiera a la misma cuenta
  -- ============================================================================
  IF p_from_account_id = v_to_account_id THEN
    RAISE EXCEPTION 'SAME_ACCOUNT: No puedes transferir a tu propia cuenta';
  END IF;
  
  -- ============================================================================
  -- 7. Validar saldo suficiente (incluyendo comisión)
  -- ============================================================================
  IF v_from_balance < p_amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Saldo insuficiente. Disponible: %, Requerido: %', 
      v_from_balance, p_amount;
  END IF;
  
  -- ============================================================================
  -- 8. Validar límites (mensual, diario, por transacción)
  -- ============================================================================
  SELECT 
    monthly_limit, 
    monthly_spent,
    daily_limit,
    daily_spent,
    per_transaction_limit
  INTO 
    v_monthly_limit, 
    v_monthly_spent,
    v_daily_limit,
    v_daily_spent,
    v_per_transaction_limit
  FROM account_limits 
  WHERE account_id = p_from_account_id 
  FOR UPDATE;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LIMITS_NOT_FOUND: Límites de cuenta no configurados';
  END IF;
  
  IF v_monthly_limit IS NOT NULL AND (v_monthly_spent + p_amount) > v_monthly_limit THEN
    RAISE EXCEPTION 'MONTHLY_LIMIT_EXCEEDED: Excede el límite mensual. Límite: %, Gastado: %, Intentando: %', 
      v_monthly_limit, v_monthly_spent, p_amount;
  END IF;
  
  IF v_daily_limit IS NOT NULL AND (v_daily_spent + p_amount) > v_daily_limit THEN
    RAISE EXCEPTION 'DAILY_LIMIT_EXCEEDED: Excede el límite diario. Límite: %, Gastado: %, Intentando: %', 
      v_daily_limit, v_daily_spent, p_amount;
  END IF;
  
  IF v_per_transaction_limit IS NOT NULL AND p_amount > v_per_transaction_limit THEN
    RAISE EXCEPTION 'PER_TRANSACTION_LIMIT_EXCEEDED: Excede el límite por transacción. Límite: %, Intentando: %', 
      v_per_transaction_limit, p_amount;
  END IF;
  
  -- ============================================================================
  -- 9. Generar número de referencia único
  -- ============================================================================
  v_reference_number := 'TRX-' || to_char(NOW(), 'YYYYMMDD') || '-' || 
                        upper(substring(gen_random_uuid()::text, 1, 8));
  
  -- ============================================================================
  -- 10. Crear la transacción de salida
  -- ============================================================================
  INSERT INTO transactions (
    transaction_type_id,
    from_account_id,
    to_account_id,
    external_cvu,
    external_cbu,
    external_alias,
    external_holder_name,
    amount,
    currency,
    concept,
    payment_method,
    payment_reference,
    status,
    commission_amount,
    net_amount,
    processed_by,
    initiated_from_device_id,
    initiated_from_ip,
    reference_number,
    processing_at,
    completed_at,
    metadata
  ) VALUES (
    v_transfer_out_type_id,
    p_from_account_id,
    NULL,
    CASE WHEN v_is_external AND p_payment_method = 'cvu' THEN p_to_identifier ELSE NULL END,
    CASE WHEN v_is_external AND p_payment_method = 'cbu' THEN p_to_identifier ELSE NULL END,
    CASE WHEN v_is_external AND p_payment_method = 'alias' THEN p_to_identifier ELSE NULL END,
    CASE WHEN v_is_external THEN v_external_holder ELSE NULL END,
    p_amount,
    'ARS',
    p_concept,
    p_payment_method,
    p_to_identifier,
    'completed',
    v_commission,
    v_net_amount,
    'system',
    p_device_id,
    p_ip_address,
    v_reference_number,
    NOW(),
    NOW(),
    jsonb_build_object(
      'is_external', v_is_external,
      'commission_applied', v_commission > 0,
      'to_account_id', v_to_account_id
    )
  ) RETURNING id INTO v_transaction_id;
  
  -- ============================================================================
  -- 11. Si es transferencia interna, crear transacción de entrada
  -- ============================================================================
  IF NOT v_is_external THEN
    INSERT INTO transactions (
      transaction_type_id,
      from_account_id,
      to_account_id,
      amount,
      currency,
      concept,
      payment_method,
      payment_reference,
      status,
      commission_amount,
      net_amount,
      processed_by,
      initiated_from_device_id,
      initiated_from_ip,
      reference_number,
      processing_at,
      completed_at,
      metadata
    ) VALUES (
      v_transfer_in_type_id,
      NULL,
      v_to_account_id,
      p_amount,
      'ARS',
      p_concept,
      p_payment_method,
      p_to_identifier,
      'completed',
      0.00,
      p_amount,
      'system',
      p_device_id,
      p_ip_address,
      v_reference_number || '-IN',
      NOW(),
      NOW(),
      jsonb_build_object(
        'related_transaction_id', v_transaction_id,
        'is_incoming', true,
        'from_account_id', p_from_account_id
      )
    );
  END IF;
  
  -- ============================================================================
  -- 12. Reconciliar balances (en lugar de actualizar manualmente)
  -- ⭐ CAMBIO AQUÍ: Usar reconcile_account_balance
  -- ============================================================================
  PERFORM reconcile_account_balance(p_from_account_id);
  
  IF NOT v_is_external THEN
    PERFORM reconcile_account_balance(v_to_account_id);
  END IF;
  
  -- ============================================================================
  -- 13. Actualizar límites (mensual y diario)
  -- ============================================================================
  UPDATE account_limits 
  SET 
    monthly_spent = monthly_spent + p_amount,
    daily_spent = daily_spent + p_amount,
    updated_at = NOW()
  WHERE account_id = p_from_account_id;
  
  -- ============================================================================
  -- 14. Obtener nuevo balance
  -- ============================================================================
  SELECT balance INTO v_from_balance FROM accounts WHERE id = p_from_account_id;
  
  -- ============================================================================
  -- 15. Construir respuesta de éxito
  -- ============================================================================
  v_result := jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'reference_number', v_reference_number,
    'amount', p_amount,
    'commission', v_commission,
    'net_amount', v_net_amount,
    'new_balance', v_from_balance,
    'is_external', v_is_external,
    'to_account_id', v_to_account_id,
    'status', 'completed',
    'timestamp', NOW()
  );
  
  RETURN v_result;
  
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Error en process_transfer: % - %', SQLERRM, SQLSTATE;
    RAISE EXCEPTION 'TRANSFER_FAILED: %', SQLERRM;
END;
$function$;


COMMIT;
