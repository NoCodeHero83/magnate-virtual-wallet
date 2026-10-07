-- =============================================================================
-- Ajustes de comisiones (revisión 2026-10-08)
--
-- * process_transfer: un alias que no existe ya no se trata como transferencia
--   externa (se debitaba y cobraba comisión de pay-out). Solo un CBU/CVU de 22
--   dígitos que no está en la billetera es externo. El identificador se recorta.
-- * quote_transfer: valida lo mismo que la transferencia (destino, misma cuenta,
--   monto menor a la comisión, saldo) para avisar antes de confirmar.
-- * distributors.cuit único.
-- * Notificación de transferencia enviada / recibida: incluye la comisión y el total.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.process_transfer(
  p_from_account_id uuid,
  p_to_identifier character varying,
  p_amount numeric,
  p_concept character varying DEFAULT ''::character varying,
  p_payment_method character varying DEFAULT 'cbu'::character varying,
  p_device_id uuid DEFAULT NULL::uuid,
  p_ip_address inet DEFAULT NULL::inet
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_transaction_id UUID;
  v_in_transaction_id UUID;
  v_to_account_id UUID;
  v_from_balance DECIMAL;
  v_monthly_limit DECIMAL;
  v_monthly_spent DECIMAL;
  v_daily_limit DECIMAL;
  v_daily_spent DECIMAL;
  v_per_transaction_limit DECIMAL;
  v_from_status VARCHAR;
  v_from_purpose TEXT;
  v_to_status VARCHAR;
  v_transfer_out_type_id UUID;
  v_transfer_in_type_id UUID;
  v_external_holder VARCHAR;
  v_is_external BOOLEAN := false;
  v_out_operation TEXT;
  v_out_rule public.fee_rules;
  v_in_rule public.fee_rules;
  v_out_fee DECIMAL := 0;
  v_in_fee DECIMAL := 0;
  v_principal DECIMAL;
  v_total_debit DECIMAL;
  v_reference_number VARCHAR;
  v_user_id UUID;
  v_identifier VARCHAR := trim(p_to_identifier);
BEGIN
  -- 1. El usuario debe ser dueño de la cuenta origen
  SELECT user_id, purpose INTO v_user_id, v_from_purpose
  FROM accounts
  WHERE id = p_from_account_id;

  IF v_user_id != auth.uid() THEN
    RAISE EXCEPTION 'UNAUTHORIZED: No tienes permisos para usar esta cuenta';
  END IF;

  IF v_from_purpose IS DISTINCT FROM 'customer' THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Esta cuenta no puede transferir';
  END IF;

  -- 2. Tipos de transacción
  SELECT id INTO v_transfer_out_type_id FROM transaction_types WHERE code = 'transfer_out';
  SELECT id INTO v_transfer_in_type_id FROM transaction_types WHERE code = 'transfer_in';

  IF v_transfer_out_type_id IS NULL OR v_transfer_in_type_id IS NULL THEN
    RAISE EXCEPTION 'TRANSACTION_TYPES_NOT_FOUND: Tipos de transacción no configurados';
  END IF;

  -- 3. Cuenta origen con bloqueo
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

  -- 4. Monto
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: El monto debe ser mayor a 0';
  END IF;

  -- 5. Cuenta destino (alias, CVU o CBU). Las cuentas de comisiones no reciben transferencias.
  SELECT id, status INTO v_to_account_id, v_to_status
  FROM accounts
  WHERE
    (LOWER(alias) = LOWER(v_identifier) OR cvu = v_identifier OR cbu = v_identifier)
    AND status = 'active'
    AND purpose = 'customer'
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM accounts
      WHERE (LOWER(alias) = LOWER(v_identifier) OR cvu = v_identifier OR cbu = v_identifier)
    ) THEN
      RAISE EXCEPTION 'DESTINATION_NOT_ACTIVE: La cuenta destino no está habilitada para recibir transferencias';
    END IF;
    IF v_identifier !~ '^\d{22}$' THEN
      RAISE EXCEPTION 'DESTINATION_NOT_FOUND: No encontramos una cuenta con ese alias, CVU o CBU';
    END IF;
    v_is_external := true;
    v_external_holder := 'Cuenta Externa';
  END IF;

  -- 6. Misma cuenta
  IF p_from_account_id = v_to_account_id THEN
    RAISE EXCEPTION 'SAME_ACCOUNT: No puedes transferir a tu propia cuenta';
  END IF;

  -- 7. Comisión de quien envía
  v_out_operation := CASE WHEN v_is_external THEN 'payout' ELSE 'internal_out' END;
  v_out_rule := public._fee_rule(p_from_account_id, v_out_operation);
  v_out_fee := public._fee_amount(v_out_rule, p_amount);

  IF v_out_fee > 0 AND v_out_rule.charge_mode = 'on_top' THEN
    v_principal := p_amount;
    v_total_debit := p_amount + v_out_fee;
  ELSE
    v_principal := p_amount - v_out_fee;
    v_total_debit := p_amount;
  END IF;

  IF v_principal <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_TOO_LOW_FOR_FEE: El monto no alcanza para cubrir la comisión (%)', v_out_fee;
  END IF;

  -- 8. Saldo suficiente (incluye la comisión)
  IF v_from_balance < v_total_debit THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: Saldo insuficiente. Disponible: %, Requerido: %',
      v_from_balance, v_total_debit;
  END IF;

  -- 9. Límites (sobre el monto de la transferencia)
  SELECT monthly_limit, monthly_spent, daily_limit, daily_spent, per_transaction_limit
  INTO v_monthly_limit, v_monthly_spent, v_daily_limit, v_daily_spent, v_per_transaction_limit
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

  -- 10. Referencia
  v_reference_number := 'TRX-' || to_char(NOW(), 'YYYYMMDD') || '-' ||
                        upper(substring(gen_random_uuid()::text, 1, 8));

  -- 11. Salida (monto que efectivamente se envía)
  INSERT INTO transactions (
    transaction_type_id, from_account_id, to_account_id,
    external_cvu, external_cbu, external_alias, external_holder_name,
    amount, currency, concept, payment_method, payment_reference, status,
    commission_amount, processed_by, initiated_from_device_id, initiated_from_ip,
    reference_number, processing_at, completed_at, metadata
  ) VALUES (
    v_transfer_out_type_id, p_from_account_id, NULL,
    CASE WHEN v_is_external AND p_payment_method = 'cvu' THEN v_identifier ELSE NULL END,
    CASE WHEN v_is_external AND p_payment_method = 'cbu' THEN v_identifier ELSE NULL END,
    CASE WHEN v_is_external AND p_payment_method = 'alias' THEN v_identifier ELSE NULL END,
    CASE WHEN v_is_external THEN v_external_holder ELSE NULL END,
    v_principal, 'ARS', p_concept, p_payment_method, v_identifier, 'completed',
    v_out_fee, 'system', p_device_id, p_ip_address,
    v_reference_number, NOW(), NOW(),
    jsonb_build_object(
      'is_external', v_is_external,
      'commission_applied', v_out_fee > 0,
      'requested_amount', p_amount,
      'commission', v_out_fee,
      'charge_mode', v_out_rule.charge_mode,
      'total_debit', v_total_debit,
      'to_account_id', v_to_account_id
    )
  ) RETURNING id INTO v_transaction_id;

  PERFORM public._charge_commission(p_from_account_id, v_out_operation, p_amount,
                                    v_out_rule, v_out_fee, v_transaction_id, v_reference_number);

  -- 12. Entrada (transferencia interna)
  IF NOT v_is_external THEN
    v_in_rule := public._fee_rule(v_to_account_id, 'internal_in');
    v_in_fee := least(public._fee_amount(v_in_rule, v_principal), v_principal);

    INSERT INTO transactions (
      transaction_type_id, from_account_id, to_account_id,
      amount, currency, concept, payment_method, payment_reference, status,
      commission_amount, processed_by, initiated_from_device_id, initiated_from_ip,
      reference_number, processing_at, completed_at, metadata
    ) VALUES (
      v_transfer_in_type_id, NULL, v_to_account_id,
      v_principal, 'ARS', p_concept, p_payment_method, v_identifier, 'completed',
      v_in_fee, 'system', p_device_id, p_ip_address,
      v_reference_number || '-IN', NOW(), NOW(),
      jsonb_build_object(
        'related_transaction_id', v_transaction_id,
        'is_incoming', true,
        'commission', v_in_fee,
        'from_account_id', p_from_account_id
      )
    ) RETURNING id INTO v_in_transaction_id;

    PERFORM public._charge_commission(v_to_account_id, 'internal_in', v_principal,
                                      v_in_rule, v_in_fee, v_in_transaction_id, v_reference_number || '-IN');
  END IF;

  -- 13. Saldos
  PERFORM reconcile_account_balance(p_from_account_id);
  IF NOT v_is_external THEN
    PERFORM reconcile_account_balance(v_to_account_id);
  END IF;

  -- 14. Límites
  UPDATE account_limits
  SET monthly_spent = monthly_spent + p_amount,
      daily_spent = daily_spent + p_amount,
      updated_at = NOW()
  WHERE account_id = p_from_account_id;

  SELECT balance INTO v_from_balance FROM accounts WHERE id = p_from_account_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'reference_number', v_reference_number,
    'amount', p_amount,
    'amount_sent', v_principal,
    'commission', v_out_fee,
    'total_debit', v_total_debit,
    'net_amount', v_principal,
    'new_balance', v_from_balance,
    'is_external', v_is_external,
    'to_account_id', v_to_account_id,
    'status', 'completed',
    'timestamp', NOW()
  );

EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Error en process_transfer: % - %', SQLERRM, SQLSTATE;
    RAISE EXCEPTION 'TRANSFER_FAILED: %', SQLERRM;
END;
$function$;

REVOKE ALL ON FUNCTION public.process_transfer(uuid, character varying, numeric, character varying, character varying, uuid, inet) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_transfer(uuid, character varying, numeric, character varying, character varying, uuid, inet) TO service_role;

CREATE OR REPLACE FUNCTION public.quote_transfer(
  p_from_account_id uuid,
  p_to_identifier character varying,
  p_amount numeric
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_identifier text := trim(p_to_identifier);
  v_from public.accounts;
  v_to public.accounts;
  v_is_external boolean := false;
  v_operation text;
  v_rule public.fee_rules;
  v_fee numeric;
  v_on_top boolean;
  v_total numeric;
  v_sent numeric;
BEGIN
  SELECT * INTO v_from FROM public.accounts WHERE id = p_from_account_id AND purpose = 'customer';
  IF v_from.id IS NULL OR v_from.user_id IS DISTINCT FROM auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_AMOUNT');
  END IF;
  IF v_from.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_NOT_ACTIVE');
  END IF;

  -- Mismo criterio que process_transfer
  SELECT * INTO v_to FROM public.accounts
   WHERE LOWER(alias) = LOWER(v_identifier) OR cvu = v_identifier OR cbu = v_identifier
   LIMIT 1;
  IF v_to.id IS NOT NULL THEN
    IF v_to.id = v_from.id THEN
      RETURN jsonb_build_object('success', false, 'error', 'SAME_ACCOUNT');
    END IF;
    IF v_to.status <> 'active' OR v_to.purpose <> 'customer' THEN
      RETURN jsonb_build_object('success', false, 'error', 'DESTINATION_NOT_ACTIVE');
    END IF;
  ELSIF v_identifier ~ '^\d{22}$' THEN
    v_is_external := true;
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'DESTINATION_NOT_FOUND');
  END IF;

  v_operation := CASE WHEN v_is_external THEN 'payout' ELSE 'internal_out' END;
  v_rule := public._fee_rule(p_from_account_id, v_operation);
  v_fee := public._fee_amount(v_rule, p_amount);
  v_on_top := v_fee > 0 AND v_rule.charge_mode = 'on_top';
  v_total := CASE WHEN v_on_top THEN p_amount + v_fee ELSE p_amount END;
  v_sent := CASE WHEN v_on_top THEN p_amount ELSE p_amount - v_fee END;

  IF v_sent <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'AMOUNT_TOO_LOW_FOR_FEE', 'fee', v_fee);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'operation', v_operation,
    'amount', p_amount,
    'fee', v_fee,
    'charge_mode', CASE WHEN v_on_top THEN 'on_top' ELSE 'deduct' END,
    'total_debit', v_total,
    'amount_sent', v_sent,
    -- Aviso previo: la transferencia igual lo valida al confirmar
    'insufficient_balance', COALESCE(v_from.balance, 0) < v_total
  );
END;
$$;
REVOKE ALL ON FUNCTION public.quote_transfer(uuid, character varying, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_transfer(uuid, character varying, numeric) TO authenticated;

-- CUIT único entre distribuidores
CREATE UNIQUE INDEX IF NOT EXISTS distributors_cuit_uq ON public.distributors(cuit) WHERE cuit IS NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_upsert_distributor(
  p_id uuid,
  p_name text,
  p_cuit text,
  p_contact_email text,
  p_status text DEFAULT 'active'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid := p_id;
  v_acc uuid;
  v_cuit text := NULLIF(regexp_replace(COALESCE(p_cuit, ''), '\D', '', 'g'), '');
  v_email text := NULLIF(trim(lower(COALESCE(p_contact_email, ''))), '');
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN: Solo un administrador puede gestionar distribuidores';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) < 2 OR length(trim(p_name)) > 120 THEN
    RAISE EXCEPTION 'INVALID_NAME: Ingresa el nombre del distribuidor (2 a 120 caracteres)';
  END IF;
  IF v_cuit IS NOT NULL AND length(v_cuit) <> 11 THEN
    RAISE EXCEPTION 'INVALID_CUIT: El CUIT debe tener 11 dígitos';
  END IF;
  IF v_email IS NOT NULL AND v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'INVALID_EMAIL: El email de contacto no es válido';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'INVALID_STATUS: Estado inválido';
  END IF;
  IF v_cuit IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.distributors WHERE cuit = v_cuit AND id IS DISTINCT FROM v_id
  ) THEN
    RAISE EXCEPTION 'CUIT_EXISTS: Ya hay un distribuidor con ese CUIT';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.distributors (name, cuit, contact_email, status, created_by)
    VALUES (trim(p_name), v_cuit, v_email, p_status, auth.uid())
    RETURNING id INTO v_id;

    v_acc := public._create_commission_account('comisiones.' || substr(replace(v_id::text, '-', ''), 1, 10));
    UPDATE public.distributors SET commission_account_id = v_acc WHERE id = v_id;
  ELSE
    UPDATE public.distributors
       SET name = trim(p_name), cuit = v_cuit, contact_email = v_email,
           status = p_status, updated_at = now()
     WHERE id = v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'NOT_FOUND: Distribuidor no encontrado';
    END IF;
  END IF;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_upsert_distributor(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_upsert_distributor(uuid, text, text, text, text) TO authenticated;

-- La notificación de la transferencia lleva la comisión y el total debitado
-- (se parchea la función porque contiene el secreto del worker)
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.trigger_enqueue_transaction_notification'::regproc);
  v_new text;
BEGIN
  IF position('commission_in_data' IN v_def) > 0 THEN
    RETURN;
  END IF;
  -- Aparece dos veces (emisor y receptor); la función usa saltos de línea 


  v_new := regexp_replace(v_def,
    '''reference_number'', NEW\.reference_number(\s*)\)',
    '''reference_number'', NEW.reference_number, /* commission_in_data */ ''commission'', COALESCE(NEW.commission_amount, 0), ''total_debit'', NEW.metadata->>''total_debit'', ''created_at'', NEW.created_at\1)',
    'g');
  -- Debe quedar en los dos mensajes (emisor y receptor)
  IF (length(v_new) - length(replace(v_new, 'commission_in_data', ''))) / length('commission_in_data') <> 2 THEN
    RAISE EXCEPTION 'No se pudo parchear trigger_enqueue_transaction_notification';
  END IF;
  EXECUTE v_new;
END $$;

-- Los correos de transferencia muestran la comisión y el total (el worker arma {{commission_html}})
UPDATE public.notification_types
   SET email_template_html = jsonb_set(email_template_html, '{es}',
         to_jsonb(replace(email_template_html->>'es',
           '<p><strong>Monto:</strong> {{amount_formatted}}</p>',
           '<p><strong>Monto:</strong> {{amount_formatted}}</p>{{commission_html}}')))
 WHERE code IN ('transaction_sent', 'transaction_received')
   AND position('{{commission_html}}' IN email_template_html->>'es') = 0;

-- =============================================================================
-- Distribuidor inactivo: no recibe la parte de las comisiones nuevas
-- =============================================================================
-- Cobra una comisión ya calculada: movimiento del cliente a la cuenta de Magnate y,
-- si el CVU tiene distribuidor, reparto de Magnate a la cuenta del distribuidor.
-- Se llama dentro de la transacción de la operación: si algo falla, no queda nada.
CREATE OR REPLACE FUNCTION public._charge_commission(
  p_payer_account_id uuid,
  p_operation text,
  p_base_amount numeric,
  p_rule public.fee_rules,
  p_fee numeric,
  p_related_transaction_id uuid,
  p_reference text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_type_id uuid;
  v_magnate_acc uuid := public._magnate_commission_account_id();
  v_distributor public.distributors;
  v_dist_amount numeric := 0;
  v_tx_id uuid;
BEGIN
  IF p_fee IS NULL OR p_fee <= 0 THEN
    RETURN NULL;
  END IF;
  IF v_magnate_acc IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_ACCOUNT_MISSING: No está configurada la cuenta de comisiones';
  END IF;

  SELECT id INTO v_type_id FROM public.transaction_types WHERE code = 'commission';

  SELECT d.* INTO v_distributor
    FROM public.accounts a
    JOIN public.distributors d ON d.id = a.distributor_id
   WHERE a.id = p_payer_account_id;

  -- Un distribuidor inactivo deja de cobrar: su parte va a Magnate
  IF v_distributor.id IS NOT NULL AND v_distributor.commission_account_id IS NOT NULL
     AND v_distributor.status = 'active' THEN
    v_dist_amount := round(p_fee * (100 - p_rule.magnate_share_percent) / 100, 2);
  END IF;

  -- Las cuentas de comisiones se actualizan antes de insertar el movimiento: así el trigger
  -- validate_balance_after_transaction ya ve el saldo correcto y no las "corrige".
  UPDATE public.accounts SET balance = balance + p_fee, updated_at = now() WHERE id = v_magnate_acc;

  INSERT INTO public.transactions (
    transaction_type_id, from_account_id, to_account_id, amount, currency, concept,
    payment_method, status, commission_amount, processed_by, reference_number,
    processing_at, completed_at, metadata
  ) VALUES (
    v_type_id, p_payer_account_id, v_magnate_acc, p_fee, 'ARS',
    'Comisión',
    'commission', 'completed', 0, 'system', p_reference || '-FEE',
    now(), now(),
    jsonb_build_object('operation', p_operation, 'related_transaction_id', p_related_transaction_id,
                       'base_amount', p_base_amount, 'charge_mode', p_rule.charge_mode)
  ) RETURNING id INTO v_tx_id;

  IF v_dist_amount > 0 THEN
    UPDATE public.accounts SET balance = balance - v_dist_amount, updated_at = now() WHERE id = v_magnate_acc;
    UPDATE public.accounts SET balance = balance + v_dist_amount, updated_at = now()
     WHERE id = v_distributor.commission_account_id;
    INSERT INTO public.transactions (
      transaction_type_id, from_account_id, to_account_id, amount, currency, concept,
      payment_method, status, commission_amount, processed_by, reference_number,
      processing_at, completed_at, metadata
    ) VALUES (
      v_type_id, v_magnate_acc, v_distributor.commission_account_id, v_dist_amount, 'ARS',
      'Comisión distribuidor',
      'commission', 'completed', 0, 'system', p_reference || '-FEE-D',
      now(), now(),
      jsonb_build_object('operation', p_operation, 'related_transaction_id', p_related_transaction_id,
                         'commission_transaction_id', v_tx_id, 'split', true)
    );
  END IF;

  INSERT INTO public.commission_entries (
    transaction_id, related_transaction_id, payer_account_id, distributor_id, operation,
    base_amount, rate_percent, fixed_amount, charge_mode, fee_total, magnate_amount, distributor_amount
  ) VALUES (
    v_tx_id, p_related_transaction_id, p_payer_account_id,
    CASE WHEN v_distributor.status = 'active' THEN v_distributor.id END,
    p_operation, p_base_amount, p_rule.rate_percent, p_rule.fixed_amount, p_rule.charge_mode,
    p_fee, p_fee - v_dist_amount, v_dist_amount
  );

  RETURN v_tx_id;
END;
$$;
