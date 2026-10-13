-- =============================================================================
-- PIN de 6 dígitos
--
-- La app pasa de 4 a 6 dígitos (confirm_pin_change ya exigía 6, por eso el cambio de
-- PIN fallaba con la app de 4). Para los usuarios que ya tienen un PIN de 4:
-- * pin_upgrade_required = true: siguen entrando con su PIN de 4, la app los lleva a
--   crear uno de 6 (PIN actual + código por email) y no pueden transferir hasta hacerlo.
-- * Si alguien entra con un PIN que no es de 6 dígitos (por ej. un registro hecho con
--   una app vieja) se marca igual.
-- =============================================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS pin_upgrade_required boolean NOT NULL DEFAULT false;

-- Todos los PIN existentes se crearon con la app de 4 dígitos
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'pin6_migrated') THEN
    UPDATE public.users SET pin_upgrade_required = true WHERE role = 'user';
    INSERT INTO public.app_settings (key, value, updated_at) VALUES ('pin6_migrated', 'true'::jsonb, now());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.protect_user_sensitive_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Solo aplica a llamadas directas desde la API (roles anon / authenticated).
  -- Las funciones SECURITY DEFINER y el service_role no pasan por aquí.
  IF current_user IN ('anon', 'authenticated') AND NOT public.is_admin() THEN
    IF NEW.role IS DISTINCT FROM OLD.role
       OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
       OR NEW.account_type IS DISTINCT FROM OLD.account_type
       OR NEW.status_reason IS DISTINCT FROM OLD.status_reason
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
       OR NEW.pin_hash IS DISTINCT FROM OLD.pin_hash
       OR NEW.pin_upgrade_required IS DISTINCT FROM OLD.pin_upgrade_required THEN
      RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.login_with_pin(p_email text, p_pin text, p_device jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user record;
  v_pin jsonb;
  v_code text;
  v_sent boolean := true;
BEGIN
  SELECT u.id, u.email, u.first_name, u.verification_status, u.account_type, u.status_reason,
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

  v_pin := public._check_pin(v_user.id, p_pin);
  IF NOT (v_pin->>'success')::boolean THEN
    RETURN v_pin;
  END IF;

  -- El PIN ahora es de 6 dígitos. Un PIN viejo (4) sigue entrando, pero la app obliga a
  -- cambiarlo y las transferencias quedan bloqueadas hasta hacerlo.
  IF COALESCE(p_pin, '') !~ '^\d{6}$' THEN
    UPDATE public.users SET pin_upgrade_required = true WHERE id = v_user.id AND NOT pin_upgrade_required;
  END IF;

  IF v_user.verification_status = 'rejected' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REJECTED', 'status_reason', v_user.status_reason);
  END IF;
  IF v_user.verification_status NOT IN ('verified', 'pending') THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_VERIFIED');
  END IF;
  IF v_user.auto_password_encrypted IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'MISSING_CREDENTIALS');
  END IF;

  -- Versiones viejas de la app no envían el dispositivo
  IF p_device IS NULL OR NOT public._valid_device(p_device) THEN
    RETURN jsonb_build_object('success', false, 'error', 'UPDATE_REQUIRED');
  END IF;

  -- Cuenta de revisión de las tiendas: el dispositivo queda de confianza sin código
  IF COALESCE((SELECT value FROM public.app_settings WHERE key = 'device_verification_bypass_emails'), '[]'::jsonb)
       ? lower(v_user.email) THEN
    PERFORM public._trust_device(v_user.id, p_device);
  END IF;

  IF public._trusted_device_id(v_user.id, p_device) IS NOT NULL THEN
    UPDATE public.user_devices SET last_active_at = now()
     WHERE user_id = v_user.id AND device_id = p_device->>'id';
    RETURN jsonb_build_object(
      'success', true,
      'user_id', v_user.id,
      'verification_status', v_user.verification_status,
      'account_type', v_user.account_type,
      'pin_upgrade_required', COALESCE(p_pin, '') !~ '^\d{6}$',
      'auto_password_encrypted', v_user.auto_password_encrypted
    );
  END IF;

  -- Dispositivo nuevo: enviar código por email. NO se entrega la credencial.
  BEGIN
    v_code := public._otp_issue('device', v_user.id, v_user.email, p_device->>'id');
  EXCEPTION WHEN OTHERS THEN
    -- Hay un código reciente para este usuario: el anterior sigue valiendo
    IF SQLERRM LIKE 'TOO_SOON%' OR SQLERRM LIKE 'TOO_MANY_REQUESTS%' THEN
      v_sent := false;
    ELSE
      RAISE;
    END IF;
  END;

  IF v_sent THEN
    PERFORM public.enqueue_notification(v_user.id, 'device_verification', jsonb_build_object(
      'otp_code', v_code,
      'device_name', COALESCE(NULLIF(p_device->>'name', ''), p_device->>'model', 'un dispositivo nuevo')
    ));
  END IF;

  RETURN jsonb_build_object('success', false, 'error', 'DEVICE_VERIFICATION_REQUIRED', 'code_sent', v_sent);
END;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_pin_change(p_code text, p_new_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hash text;
  v_check jsonb;
BEGIN
  SELECT pin_hash INTO v_hash FROM public.users WHERE id = v_uid;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;

  IF COALESCE(p_new_pin, '') !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_NEW_PIN');
  END IF;
  IF v_hash ~ '^\$2[aby]\$' AND crypt(p_new_pin, '$2a$' || substr(v_hash, 5)) = '$2a$' || substr(v_hash, 5) THEN
    RETURN jsonb_build_object('success', false, 'error', 'SAME_PIN');
  END IF;

  v_check := public._otp_verify('pin_change', v_uid, NULL, p_code);
  IF NOT (v_check->>'success')::boolean THEN
    RETURN v_check;
  END IF;

  UPDATE public.users SET pin_hash = crypt(p_new_pin, gen_salt('bf', 10)), pin_upgrade_required = false WHERE id = v_uid;
  DELETE FROM public.pin_login_attempts WHERE user_id = v_uid;

  PERFORM public.enqueue_notification(v_uid, 'pin_changed', '{}'::jsonb);
  RETURN jsonb_build_object('success', true);
END;
$function$;

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

  -- PIN de 4 dígitos (versión anterior de la app): debe pasar a 6 antes de transferir
  IF EXISTS (SELECT 1 FROM users WHERE id = v_user_id AND pin_upgrade_required) THEN
    RAISE EXCEPTION 'PIN_UPGRADE_REQUIRED: Actualiza tu PIN a 6 dígitos desde la app para poder transferir';
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
