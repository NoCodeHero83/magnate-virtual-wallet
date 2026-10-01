-- =============================================================================
-- Correcciones de la revisión de Persona Jurídica
-- Fecha: 2026-10-03
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Fuga de datos: vistas que se ejecutaban con permisos del dueño (ignorando
--    RLS) y eran legibles sin sesión. Exponían todas las transacciones con
--    email/teléfono/DNI, movimientos, saldos y estadísticas de notificaciones.
--    Ahora usan security_invoker (aplican RLS de quien consulta) y no son
--    accesibles para anon.
-- -----------------------------------------------------------------------------

-- Nombre del titular para mostrar en transferencias / movimientos:
-- razón social para Persona Jurídica, nombre y apellido para Persona Física.
-- SECURITY DEFINER para poder resolver el nombre de la contraparte, que el
-- usuario no puede leer por RLS.
CREATE OR REPLACE FUNCTION public.user_holder_name(p_user_id uuid)
RETURNS varchar
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT (CASE
            WHEN u.account_type = 'business' AND bp.legal_name IS NOT NULL THEN bp.legal_name
            ELSE trim(u.first_name || ' ' || u.last_name)
          END)::varchar
    FROM public.users u
    LEFT JOIN public.business_profiles bp ON bp.user_id = u.id
   WHERE u.id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.account_holder_name(p_account_id uuid)
RETURNS varchar
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT public.user_holder_name(a.user_id) FROM public.accounts a WHERE a.id = p_account_id;
$$;

REVOKE ALL ON FUNCTION public.user_holder_name(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.account_holder_name(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_holder_name(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_holder_name(uuid) TO authenticated;

-- Movimientos de cuenta (app y web): misma forma, contraparte con razón social
CREATE OR REPLACE VIEW public.account_movements
WITH (security_invoker = true) AS
SELECT a.id AS account_id,
    a.user_id,
    t.id AS transaction_id,
    t.created_at,
    t.completed_at,
    t.amount,
    t.concept,
    t.payment_method,
    t.reference_number,
    tt.category,
    tt.name AS transaction_type_name,
        CASE
            WHEN t.to_account_id = a.id THEN 'income'::text
            WHEN t.from_account_id = a.id THEN 'expense'::text
            ELSE 'other'::text
        END AS movement_type,
        CASE
            WHEN t.to_account_id = a.id THEN t.amount
            ELSE 0::numeric
        END AS income_amount,
        CASE
            WHEN t.from_account_id = a.id THEN t.amount
            ELSE 0::numeric
        END AS expense_amount,
    t.status,
        CASE
            -- Interna: nombre del titular de la otra cuenta (antes se mostraba el alias,
            -- y quien recibía veía su propio alias). process_transfer guarda cada
            -- transferencia interna como 2 filas (salida y entrada); la cuenta de la
            -- contraparte queda en metadata. Externa: titular externo o referencia.
            WHEN t.from_account_id = a.id THEN COALESCE(
              public.account_holder_name(COALESCE(t.to_account_id, (t.metadata ->> 'to_account_id')::uuid)),
              t.external_holder_name, t.payment_reference)
            WHEN t.to_account_id = a.id THEN COALESCE(
              public.account_holder_name(COALESCE(t.from_account_id, (t.metadata ->> 'from_account_id')::uuid)),
              t.external_holder_name, t.payment_reference)
            ELSE NULL::character varying
        END AS counterpart_name,
    t.payment_reference
   FROM accounts a
     LEFT JOIN transactions t ON t.from_account_id = a.id OR t.to_account_id = a.id
     LEFT JOIN transaction_types tt ON t.transaction_type_id = tt.id
  WHERE t.status::text = 'completed'::text;

-- Transacciones del panel admin: mismas columnas + nombre del titular
CREATE OR REPLACE VIEW public.admin_transaction_list
WITH (security_invoker = true) AS
SELECT t.id,
    t.transaction_type_id,
    t.from_account_id,
    t.to_account_id,
    t.external_cvu,
    t.external_cbu,
    t.external_alias,
    t.external_holder_name,
    t.amount,
    t.currency,
    t.concept,
    t.payment_method,
    t.payment_reference,
    t.status,
    t.commission_amount,
    t.net_amount,
    t.processed_by,
    t.failure_reason,
    t.reference_number,
    t.metadata,
    t.initiated_from_device_id,
    t.initiated_from_ip,
    t.created_at,
    t.processing_at,
    t.completed_at,
    t.failed_at,
    fu.first_name AS from_user_first_name,
    fu.last_name AS from_user_last_name,
    fu.email AS from_user_email,
    fu.phone AS from_user_phone,
    fu.dni AS from_user_dni,
    tu.first_name AS to_user_first_name,
    tu.last_name AS to_user_last_name,
    tu.email AS to_user_email,
    tu.phone AS to_user_phone,
    tu.dni AS to_user_dni,
    -- Titulares (incluye la contraparte guardada en metadata en la doble entrada)
    public.account_holder_name(COALESCE(t.from_account_id, (t.metadata ->> 'from_account_id')::uuid)) AS from_holder_name,
    public.account_holder_name(COALESCE(t.to_account_id, (t.metadata ->> 'to_account_id')::uuid)) AS to_holder_name
   FROM transactions t
     LEFT JOIN accounts fa ON t.from_account_id = fa.id
     LEFT JOIN users fu ON fa.user_id = fu.id
     LEFT JOIN accounts ta ON t.to_account_id = ta.id
     LEFT JOIN users tu ON ta.user_id = tu.id
  WHERE public.is_admin();

ALTER VIEW public.account_balance_reconciliation SET (security_invoker = true);
ALTER VIEW public.notification_stats_by_user SET (security_invoker = true);

REVOKE ALL ON public.account_movements, public.admin_transaction_list,
              public.account_balance_reconciliation, public.notification_stats_by_user
  FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.account_movements, public.admin_transaction_list,
     public.account_balance_reconciliation, public.notification_stats_by_user
  FROM authenticated;
GRANT SELECT ON public.account_movements, public.admin_transaction_list,
                public.account_balance_reconciliation, public.notification_stats_by_user
  TO authenticated;

-- -----------------------------------------------------------------------------
-- 2. Nombre del titular al buscar destinatario / validar QR: razón social para
--    empresas. Ya no se pueden consultar sin sesión (devolvían nombres por alias).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_account_for_transfer(p_identifier character varying)
 RETURNS TABLE(account_id uuid, holder_name character varying, alias character varying, is_external boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Buscar cuenta interna
  RETURN QUERY
  SELECT
    a.id as account_id,
    public.user_holder_name(a.user_id) as holder_name,
    a.alias,
    false as is_external
  FROM accounts a
  WHERE a.status = 'active'
    AND (
      LOWER(a.alias) = LOWER(p_identifier)
      OR a.cbu = p_identifier
      OR a.cvu = p_identifier
    )
  LIMIT 1;

  -- Si no hay resultados y parece CBU/CVU externo
  IF NOT FOUND AND p_identifier ~ '^\d{22}$' THEN
    RETURN QUERY
    SELECT
      NULL::UUID as account_id,
      CAST('Cuenta Externa' AS VARCHAR) as holder_name,
      NULL::VARCHAR as alias,
      true as is_external;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_qr(p_qr_hash character varying)
 RETURNS TABLE(is_valid boolean, account_id uuid, cvu character varying, holder_name character varying, account_status character varying)
 LANGUAGE plpgsql
 STABLE
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    true AS is_valid,
    a.id,
    a.cvu,
    public.user_holder_name(a.user_id),
    a.status
  FROM qr_codes qr
  JOIN accounts a ON qr.account_id = a.id
  WHERE
    qr.qr_hash = p_qr_hash
    AND qr.is_active = true
    AND a.status = 'active';

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.generate_static_qr(p_account_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_qr_id UUID;
  v_cvu VARCHAR;
  v_user_name VARCHAR;
  v_qr_data JSONB;
  v_qr_hash VARCHAR;
BEGIN
  SELECT a.cvu, public.user_holder_name(a.user_id)
  INTO v_cvu, v_user_name
  FROM accounts a
  WHERE a.id = p_account_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cuenta no encontrada';
  END IF;

  v_qr_data := jsonb_build_object(
    'cvu', v_cvu,
    'account_id', p_account_id,
    'holder_name', v_user_name,
    'version', '1.0',
    'type', 'static'
  );

  v_qr_hash := encode(digest(v_qr_data::TEXT, 'sha256'), 'hex');

  INSERT INTO qr_codes (account_id, qr_data, qr_hash, qr_type, is_active)
  VALUES (p_account_id, v_qr_data::TEXT, v_qr_hash, 'static', true)
  RETURNING id INTO v_qr_id;

  RETURN v_qr_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.search_account_for_transfer(character varying) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.validate_qr(character varying) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.generate_static_qr(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_account_for_transfer(character varying) TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_qr(character varying) TO authenticated;
GRANT EXECUTE ON FUNCTION public.generate_static_qr(uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 3. Login: bloqueo temporal en lugar de suspensión
--    Antes, 3 PIN incorrectos suspendían la cuenta: cualquiera que conociera un
--    email podía suspender cuentas ajenas, y pisaba el estado pending/rejected.
--    Ahora: 3 fallos en 15 min => bloqueo de 15 min. No cambia el estado.
-- -----------------------------------------------------------------------------
ALTER TABLE public.pin_login_attempts
  ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE OR REPLACE FUNCTION public.login_with_pin(p_email text, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
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
$$;

-- -----------------------------------------------------------------------------
-- 4. Registro: comprobar el CUIT de la empresa en el paso de datos de empresa
--    (antes el duplicado se detectaba recién al final del registro)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_company_cuit_available(p_cuit text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.business_profiles
     WHERE cuit = regexp_replace(COALESCE(p_cuit, ''), '\D', '', 'g')
  );
$$;
REVOKE ALL ON FUNCTION public.is_company_cuit_available(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_company_cuit_available(text) TO anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. enqueue_notification ya no se puede usar sin sesión (permitía enviar
--    emails a cualquier dirección a través del worker). El registro usa
--    request_signup_email_otp.
-- -----------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.enqueue_notification(uuid, text, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_notification(uuid, text, jsonb, uuid) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. app_settings: el panel guarda los switches con upsert (crea la fila si falta)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can insert app settings" ON public.app_settings;
CREATE POLICY "Admins can insert app settings" ON public.app_settings
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

COMMIT;
