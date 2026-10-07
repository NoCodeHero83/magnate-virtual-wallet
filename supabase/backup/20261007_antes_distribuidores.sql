-- Respaldo de funciones y vistas antes de la migración 20261007_distribuidores_comisiones (2026-10-07)

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

  -- El hash del PIN ya se guardó en public.users: no debe quedar en user_metadata (viaja en el JWT)
  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data - 'pin_hash' WHERE id = NEW.id;

  RAISE LOG 'Usuario creado en public.users: % (tipo %, estado %)', NEW.id, v_account_type, v_status;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'ERROR EN TRIGGER handle_new_user: %', SQLERRM;
    RAISE EXCEPTION 'Error creando perfil de usuario: %', SQLERRM;
END;
$function$;

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

CREATE OR REPLACE FUNCTION public.account_holder_name(p_account_id uuid)
 RETURNS character varying
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT public.user_holder_name(a.user_id) FROM public.accounts a WHERE a.id = p_account_id;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_enqueue_transaction_notification()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_sender_user_id UUID;
  v_receiver_user_id UUID;
  v_transaction_category TEXT;
  last_invoked TIMESTAMPTZ;
  can_invoke BOOLEAN;
BEGIN
  -- Solo procesar transacciones completadas
  IF NEW.status = 'completed' THEN
    
    -- Obtener la categoría del tipo de transacción
    SELECT category INTO v_transaction_category
    FROM transaction_types
    WHERE id = NEW.transaction_type_id;

    -- 1. Notificar al EMISOR (Gasto/Transferencia enviada)
    IF NEW.from_account_id IS NOT NULL THEN
      SELECT user_id INTO v_sender_user_id
      FROM accounts
      WHERE id = NEW.from_account_id;

      IF v_sender_user_id IS NOT NULL THEN
        PERFORM pgmq.send(
          queue_name := 'notification_jobs',
          msg := jsonb_build_object(
            'user_id', v_sender_user_id,
            'notification_type', 'transaction_sent',
            'data', jsonb_build_object(
              'transaction_id', NEW.id,
              'amount', NEW.amount,
              'currency', NEW.currency,
              'reference_number', NEW.reference_number
            ),
            'related_transaction_id', NEW.id,
            'created_at', NOW()
          )
        );
      END IF;
    END IF;

    -- 2. Notificar al RECEPTOR (Ingreso/Transferencia recibida)
    IF NEW.to_account_id IS NOT NULL AND (v_transaction_category = 'income' OR NEW.from_account_id IS NOT NULL) THEN
      SELECT user_id INTO v_receiver_user_id
      FROM accounts
      WHERE id = NEW.to_account_id;

      IF v_receiver_user_id IS NOT NULL AND v_receiver_user_id != v_sender_user_id THEN
        PERFORM pgmq.send(
          queue_name := 'notification_jobs',
          msg := jsonb_build_object(
            'user_id', v_receiver_user_id,
            'notification_type', 'transaction_received',
            'data', jsonb_build_object(
              'transaction_id', NEW.id,
              'amount', NEW.amount,
              'currency', NEW.currency,
              'reference_number', NEW.reference_number
            ),
            'related_transaction_id', NEW.id,
            'created_at', NOW()
          )
        );
      END IF;
    END IF;

    -- ✅ LLAMADA INMEDIATA AL WORKER (con debouncing y secret)
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
        
        -- Invocar worker con secret de seguridad
        PERFORM net.http_post(
          url := 'https://mzxhyjgbbabnughknrxc.supabase.co/functions/v1/notification-worker',
          headers := '{"Content-Type": "application/json", "x-worker-secret": "<REDACTED_WORKER_SECRET>"}'::jsonb,
          timeout_milliseconds := 30000
        );
        
        RAISE NOTICE '🚀 Worker invocado por trigger de transacción';
      ELSE
        RAISE NOTICE '⏭️ Worker ya invocado recientemente';
      END IF;
      
    EXCEPTION
      WHEN OTHERS THEN
        RAISE WARNING 'Error invocando worker desde trigger: %, el cron lo procesará', SQLERRM;
    END;

  END IF;
  
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.calculate_net_amount()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.net_amount := NEW.amount - COALESCE(NEW.commission_amount, 0);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE VIEW public.admin_user_list WITH (security_invoker = true) AS
 SELECT u.id,
    u.first_name,
    u.last_name,
    u.email,
    u.phone,
    u.dni,
    u.cuit_cuil,
    u.role,
    u.verification_status,
    u.account_type,
    u.status_reason,
    u.reviewed_by,
    u.reviewed_at,
    u.photo_url,
    u.created_at,
    u.updated_at,
    bp.cuit AS company_cuit,
    bp.legal_name AS company_legal_name,
    bp.trade_name AS company_trade_name,
    bp.legal_entity_type AS company_entity_type,
    let.name AS company_entity_type_name,
    bp.incorporation_date AS company_incorporation_date,
    u.zapsign_contract_url
   FROM ((users u
     LEFT JOIN business_profiles bp ON ((bp.user_id = u.id)))
     LEFT JOIN legal_entity_types let ON ((let.code = bp.legal_entity_type)));
