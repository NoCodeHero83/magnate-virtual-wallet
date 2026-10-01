-- Respaldo antes de 20261003_review_fixes.sql (las vistas eran SIN security_invoker y legibles por anon)

CREATE OR REPLACE VIEW public.account_balance_reconciliation AS  SELECT id AS account_id,
    user_id,
    cvu,
    alias,
    balance AS balance_materialized,
    calculate_account_balance(id) AS balance_calculated,
    balance - calculate_account_balance(id) AS difference,
        CASE
            WHEN abs(balance - calculate_account_balance(id)) < 0.01 THEN 'OK'::text
            WHEN abs(balance - calculate_account_balance(id)) < 1.00 THEN 'WARNING'::text
            ELSE 'ERROR'::text
        END AS status,
    updated_at AS last_balance_update,
    ( SELECT count(*) AS count
           FROM transactions t
          WHERE (t.from_account_id = a.id OR t.to_account_id = a.id) AND t.status::text = 'completed'::text) AS total_transactions
   FROM accounts a
  WHERE status::text = 'active'::text;

CREATE OR REPLACE VIEW public.account_movements AS  SELECT a.id AS account_id,
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
            WHEN t.from_account_id = a.id THEN COALESCE(t.payment_reference, t.external_holder_name, (( SELECT (u.first_name::text || ' '::text) || u.last_name::text
               FROM accounts ta
                 JOIN users u ON ta.user_id = u.id
              WHERE ta.id = t.to_account_id))::character varying)
            WHEN t.to_account_id = a.id THEN COALESCE(t.payment_reference, t.external_holder_name, (( SELECT (u.first_name::text || ' '::text) || u.last_name::text
               FROM accounts ta
                 JOIN users u ON ta.user_id = u.id
              WHERE ta.id = t.from_account_id))::character varying)
            ELSE NULL::character varying
        END AS counterpart_name,
    t.payment_reference
   FROM accounts a
     LEFT JOIN transactions t ON t.from_account_id = a.id OR t.to_account_id = a.id
     LEFT JOIN transaction_types tt ON t.transaction_type_id = tt.id
  WHERE t.status::text = 'completed'::text;

CREATE OR REPLACE VIEW public.admin_transaction_list AS  SELECT t.id,
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
    tu.dni AS to_user_dni
   FROM transactions t
     LEFT JOIN accounts fa ON t.from_account_id = fa.id
     LEFT JOIN users fu ON fa.user_id = fu.id
     LEFT JOIN accounts ta ON t.to_account_id = ta.id
     LEFT JOIN users tu ON ta.user_id = tu.id;

CREATE OR REPLACE VIEW public.notification_stats_by_user AS  SELECT user_id,
    count(*) AS total_notifications,
    count(*) FILTER (WHERE status = 'sent'::text) AS sent_count,
    count(*) FILTER (WHERE status = 'delivered'::text) AS delivered_count,
    count(*) FILTER (WHERE status = 'opened'::text) AS opened_count,
    count(*) FILTER (WHERE status = 'failed'::text) AS failed_count,
    count(*) FILTER (WHERE category = 'transaction'::text) AS transaction_count,
    count(*) FILTER (WHERE category = 'security'::text) AS security_count,
    max(sent_at) AS last_notification_sent_at
   FROM notification_log nl
  GROUP BY user_id;

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
  -- Obtener datos de la cuenta
  SELECT 
    a.cvu,
    u.first_name || ' ' || u.last_name
  INTO v_cvu, v_user_name
  FROM accounts a
  JOIN users u ON a.user_id = u.id
  WHERE a.id = p_account_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cuenta no encontrada';
  END IF;
  
  -- Crear datos del QR
  v_qr_data := jsonb_build_object(
    'cvu', v_cvu,
    'account_id', p_account_id,
    'holder_name', v_user_name,
    'version', '1.0',
    'type', 'static'
  );
  
  -- Generar hash del QR
  v_qr_hash := encode(digest(v_qr_data::TEXT, 'sha256'), 'hex');
  
  -- Insertar QR code
  INSERT INTO qr_codes (
    account_id,
    qr_data,
    qr_hash,
    qr_type,
    is_active
  ) VALUES (
    p_account_id,
    v_qr_data::TEXT,
    v_qr_hash,
    'static',
    true
  ) RETURNING id INTO v_qr_id;
  
  RETURN v_qr_id;
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
$function$
;

CREATE OR REPLACE FUNCTION public.search_account_for_transfer(p_identifier character varying)
 RETURNS TABLE(account_id uuid, holder_name character varying, alias character varying, is_external boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  -- Buscar cuenta interna
  RETURN QUERY
  SELECT 
    a.id as account_id,
    CAST((u.first_name || ' ' || u.last_name) AS VARCHAR) as holder_name,  -- ⭐ CAST AQUÍ
    a.alias,
    false as is_external
  FROM accounts a
  JOIN users u ON a.user_id = u.id
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
      CAST('Cuenta Externa' AS VARCHAR) as holder_name,  -- ⭐ CAST AQUÍ
      NULL::VARCHAR as alias,
      true as is_external;
  END IF;
END;
$function$
;

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
    u.first_name || ' ' || u.last_name,
    a.status
  FROM qr_codes qr
  JOIN accounts a ON qr.account_id = a.id
  JOIN users u ON a.user_id = u.id
  WHERE 
    qr.qr_hash = p_qr_hash
    AND qr.is_active = true
    AND a.status = 'active';
    
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, NULL::UUID, NULL::VARCHAR, NULL::VARCHAR, NULL::VARCHAR;
  END IF;
END;
$function$
;
