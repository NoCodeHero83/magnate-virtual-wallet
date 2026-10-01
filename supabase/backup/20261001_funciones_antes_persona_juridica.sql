-- Respaldo de funciones antes de la migración persona_juridica (2026-10-01)

CREATE OR REPLACE FUNCTION public.create_user_bank_account(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$DECLARE
  v_account_id UUID;
  v_account_type_id UUID;
  v_cbu VARCHAR(22);
  v_cvu VARCHAR(22);
  v_alias VARCHAR(50);
  v_user_dni VARCHAR; -- Cambiamos variable a DNI
  v_qr_id UUID;
  v_qr_hash VARCHAR(64);
  v_qr_data TEXT;
  v_result JSONB;
  v_account_count INTEGER;
BEGIN
  -- Verificar que el usuario no tenga ya una cuenta
  SELECT COUNT(*) INTO v_account_count
  FROM accounts
  WHERE user_id = p_user_id;
  
  IF v_account_count > 0 THEN
    RAISE EXCEPTION 'USER_HAS_ACCOUNT: El usuario ya tiene una cuenta bancaria';
  END IF;

  -- 1. Obtener el DNI del usuario
  SELECT dni INTO v_user_dni
  FROM users 
  WHERE id = p_user_id;

  -- Validación por seguridad (aunque tu tabla dice NOT NULL, es buena práctica)
  IF v_user_dni IS NULL THEN
     RAISE EXCEPTION 'USER_DNI_MISSING: El usuario no tiene DNI asignado';
  END IF;
  
  -- Obtener el tipo de cuenta por defecto
  SELECT id INTO v_account_type_id
  FROM account_types
  WHERE code = 'savings_ars' AND is_active = true
  LIMIT 1;
  
  IF v_account_type_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_TYPE_NOT_FOUND: Tipo de cuenta no encontrado';
  END IF;
  
  -- Generar CBU y CVU únicos
  v_cbu := generate_unique_cbu();
  v_cvu := generate_unique_cvu();
  
  -- 2. Generar el ALIAS con el formato magnate.DNI
  -- IMPORTANTE: Usamos REPLACE para quitar puntos si el DNI viene formateado (ej: 30.123.456 -> 30123456)
  v_alias := 'magnate.' || REPLACE(v_user_dni, '.', '');
  
  -- Crear la cuenta bancaria
  INSERT INTO accounts (
    user_id,
    account_type_id,
    cbu,
    cvu,
    alias,
    balance,
    status,
    is_primary,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    v_account_type_id,
    v_cbu,
    v_cvu,
    v_alias,
    0.00,
    'active',
    true,
    NOW(),
    NOW()
  ) RETURNING id INTO v_account_id;
  
  -- Crear límites de la cuenta
  INSERT INTO account_limits (
    account_id,
    monthly_limit,
    monthly_spent,
    daily_limit,
    daily_spent,
    per_transaction_limit,
    current_period_start,
    current_period_end,
    updated_at
  ) VALUES (
    v_account_id,
    800000.00,
    0.00,
    50000.00,
    0.00,
    100000.00,
    date_trunc('month', CURRENT_DATE)::DATE,
    (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::DATE,
    NOW()
  );
  
  -- Generar datos del QR
  v_qr_data := jsonb_build_object(
    'account_id', v_account_id,
    'cvu', v_cvu,
    'cbu', v_cbu,
    'alias', v_alias,
    'type', 'static'
  )::TEXT;
  
  -- Generar hash
  v_qr_hash := replace(gen_random_uuid()::TEXT, '-', '');
  
  -- Crear código QR estático
  INSERT INTO qr_codes (
    account_id,
    qr_data,
    qr_hash,
    qr_type,
    amount,
    concept,
    expires_at,
    max_uses,
    is_active,
    times_used,
    created_at,
    updated_at
  ) VALUES (
    v_account_id,
    v_qr_data,
    v_qr_hash,
    'static',
    NULL,
    'Pago con QR',
    NULL,
    NULL,
    true,
    0,
    NOW(),
    NOW()
  ) RETURNING id INTO v_qr_id;
  
  -- Construir respuesta
  v_result := jsonb_build_object(
    'success', true,
    'account_id', v_account_id,
    'cbu', v_cbu,
    'cvu', v_cvu,
    'alias', v_alias,
    'balance', 0.00,
    'qr_id', v_qr_id,
    'qr_hash', v_qr_hash,
    'created_at', NOW()
  );
  
  RAISE NOTICE 'Cuenta creada para usuario % con DNI: Alias=%', p_user_id, v_alias;
  
  RETURN v_result;
  
EXCEPTION
  WHEN OTHERS THEN
    RAISE EXCEPTION 'CREATE_ACCOUNT_FAILED: %', SQLERRM;
END;$function$
;

CREATE OR REPLACE FUNCTION public.enqueue_notification(p_user_id uuid, p_notification_type text, p_data jsonb DEFAULT '{}'::jsonb, p_related_transaction_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_message JSONB;
  last_invoked TIMESTAMPTZ;
  can_invoke BOOLEAN;
BEGIN
  -- Construir el mensaje para la cola
  v_message := jsonb_build_object(
    'user_id', p_user_id,
    'notification_type', p_notification_type,
    'data', p_data,
    'related_transaction_id', p_related_transaction_id,
    'created_at', NOW()
  );
  
  -- Enviar a la cola
  PERFORM pgmq.send(
    queue_name := 'notification_jobs',
    msg := v_message
  );
  
  RAISE NOTICE 'Notificación encolada para usuario %', p_user_id;
  
  -- ✅ INVOCAR WORKER INMEDIATAMENTE (con debouncing)
  BEGIN
    -- Obtener última invocación con lock
    SELECT last_invoked_at INTO last_invoked 
    FROM public.worker_invocations 
    FOR UPDATE SKIP LOCKED;
    
    -- Solo invocar si han pasado más de 3 segundos
    can_invoke := last_invoked IS NULL OR (NOW() - last_invoked) > INTERVAL '3 seconds';
    
    IF can_invoke THEN
      -- Actualizar timestamp
      UPDATE public.worker_invocations 
      SET last_invoked_at = NOW()
      WHERE id = TRUE;
      
      -- Invocar worker con secret
      PERFORM net.http_post(
        url := 'https://mzxhyjgbbabnughknrxc.supabase.co/functions/v1/notification-worker',
        headers := '{"Content-Type": "application/json", "x-worker-secret": "<REDACTADO - ver función en Supabase>"}'::jsonb,
        timeout_milliseconds := 30000
      );
      
      RAISE NOTICE '🚀 Worker invocado inmediatamente';
    ELSE
      RAISE NOTICE '⏭️ Worker ya invocado recientemente';
    END IF;
    
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'Error invocando worker: %, el cron lo procesará', SQLERRM;
  END;
  
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_user_login_data(email_input text)
 RETURNS TABLE(id uuid, email text, pin_hash text, verification_status text, web_access_enabled boolean, web_password_hash text, auto_password_encrypted text, first_name text)
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
    u.first_name::text
  FROM public.users u
  LEFT JOIN public.user_auth_credentials c ON c.user_id = u.id
  WHERE u.email = email_input;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RAISE LOG 'Trigger handle_new_user ejecutándose para: %', NEW.email;

  INSERT INTO public.users (
    id, email, first_name, last_name, phone, dni, cuit_cuil,
    pin_hash, verification_status, web_access_enabled,
    zapsign_verification_id, zapsign_contract_url, zapsign_data,
    created_at, updated_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'nombres', 'FALTA_NOMBRE'),
    COALESCE(NEW.raw_user_meta_data->>'apellidos', 'FALTA_APELLIDO'),
    COALESCE(NEW.raw_user_meta_data->>'telefono', '0000000000'),
    COALESCE(NEW.raw_user_meta_data->>'dni', '00000000'),
    COALESCE(NEW.raw_user_meta_data->>'cuit', '00000000000'),
    COALESCE(NEW.raw_user_meta_data->>'pin_hash', 'NO_HASH_SENT'),
    'verified',
    false,
    -- ✅ Buscar doc_token en todas las variantes posibles
    COALESCE(
        NEW.raw_user_meta_data->>'zapsign_verification_id',
        NEW.raw_user_meta_data->>'zapsign_doc_token',
        NEW.raw_user_meta_data->>'zapsign_id'
    ),
    -- ✅ Buscar contract URL en todas las variantes
    COALESCE(
        NEW.raw_user_meta_data->>'zapsign_contract_url',
        NEW.raw_user_meta_data->>'zapsign_url',
        NEW.raw_user_meta_data->>'zapsign_signed_file'
    ),
    NEW.raw_user_meta_data->'zapsign_data',
    NOW(),
    NOW()
  );

  RAISE LOG 'Usuario creado en public.users: % con data ZapSign', NEW.id;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'ERROR EN TRIGGER handle_new_user: %', SQLERRM;
    RAISE EXCEPTION 'Error creando perfil de usuario: %', SQLERRM;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  );
END;
$function$
;

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
  
  -- Si no se encuentra, es una transferencia externa
  IF NOT FOUND THEN
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
$function$
;

CREATE OR REPLACE FUNCTION public.suspend_user_account(p_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  UPDATE public.users
  SET verification_status = 'suspended'
  WHERE id = p_user_id;

  -- Opcional: Loggear la acción
  RAISE NOTICE 'Cuenta % suspendida por seguridad.', p_user_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.trigger_create_account_on_user_signup()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  -- Crear cuenta bancaria automáticamente usando el nombre calificado del esquema
  -- Esto evita errores si el search_path no incluye public en el contexto del trigger
  v_result := public.create_user_bank_account(NEW.id);
  RAISE NOTICE 'Cuenta creada automáticamente para usuario %: %', NEW.id, v_result;
  
  RETURN NEW;
END;
$function$
;

