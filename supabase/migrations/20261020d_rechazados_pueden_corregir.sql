-- Cuentas rechazadas: pueden entrar a la app, ver el motivo y corregir su documentación.
--
-- * login_with_pin y verify_device_login ya no cortan el ingreso de una cuenta rechazada. La
--   cuenta de dinero sigue bloqueada (accounts.status = 'blocked', status_reason
--   'account_rejected'), así que no puede enviar ni recibir dinero.
-- * submit_business_document: cuando una empresa rechazada vuelve a subir sus documentos y ya
--   no le queda ninguno rechazado, la cuenta vuelve a 'pending' para que un admin la revise.
-- La web sigue sin permitir el ingreso de cuentas rechazadas (web_login_check).

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

  -- Una cuenta rechazada entra (ve el motivo y corrige su documentación), pero su cuenta de
  -- dinero sigue bloqueada hasta que un admin la apruebe.
  IF v_user.verification_status NOT IN ('verified', 'pending', 'rejected') THEN
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

  RETURN jsonb_strip_nulls(jsonb_build_object('success', false, 'error', 'DEVICE_VERIFICATION_REQUIRED', 'code_sent', v_sent,
                                             'debug_code', public._debug_code(v_code)));
END;
$function$;

CREATE OR REPLACE FUNCTION public.verify_device_login(p_email text, p_device jsonb, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user record;
  v_check jsonb;
BEGIN
  SELECT u.id, u.verification_status, u.account_type, u.status_reason, c.auto_password_encrypted
    INTO v_user
    FROM public.users u
    LEFT JOIN public.user_auth_credentials c ON c.user_id = u.id
   WHERE lower(u.email) = lower(trim(COALESCE(p_email, '')));

  IF NOT FOUND OR p_device IS NULL OR NOT public._valid_device(p_device) THEN
    RETURN jsonb_build_object('success', false, 'error', 'CODE_EXPIRED');
  END IF;

  v_check := public._otp_verify('device', v_user.id, p_device->>'id', p_code);
  IF NOT (v_check->>'success')::boolean THEN
    RETURN v_check;
  END IF;

  -- El estado pudo cambiar mientras tanto
  IF v_user.verification_status = 'suspended' THEN
    RETURN jsonb_build_object('success', false, 'error', 'SUSPENDED');
  END IF;
  IF v_user.auto_password_encrypted IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'MISSING_CREDENTIALS');
  END IF;

  PERFORM public._trust_device(v_user.id, p_device);

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_user.id,
    'verification_status', v_user.verification_status,
    'account_type', v_user.account_type,
    'auto_password_encrypted', v_user.auto_password_encrypted
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.submit_business_document(p_doc_type text, p_storage_path text, p_file_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_object storage.objects;
  v_current public.business_documents;
  v_size bigint;
  v_mime text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_uid AND account_type = 'business' AND role = 'user') THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_BUSINESS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.business_document_types WHERE code = p_doc_type AND is_active) THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_TYPE');
  END IF;
  IF p_storage_path NOT LIKE 'kyb/' || v_uid::text || '/' || p_doc_type || '/%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PATH');
  END IF;

  SELECT * INTO v_object FROM storage.objects WHERE bucket_id = 'documents' AND name = p_storage_path;
  IF v_object.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'FILE_NOT_FOUND');
  END IF;
  v_size := COALESCE((v_object.metadata->>'size')::bigint, 0);
  v_mime := COALESCE(v_object.metadata->>'mimetype', 'application/octet-stream');
  IF v_size > 10 * 1024 * 1024 THEN
    RETURN jsonb_build_object('success', false, 'error', 'FILE_TOO_LARGE');
  END IF;
  IF v_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FILE');
  END IF;

  SELECT * INTO v_current FROM public.business_documents
   WHERE user_id = v_uid AND doc_type = p_doc_type AND status <> 'replaced'
   FOR UPDATE;
  IF v_current.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_APPROVED');
  END IF;
  IF v_current.id IS NOT NULL THEN
    UPDATE public.business_documents SET status = 'replaced' WHERE id = v_current.id;
  END IF;

  INSERT INTO public.business_documents (user_id, doc_type, storage_path, file_name, mime_type, size_bytes)
  VALUES (v_uid, p_doc_type, p_storage_path, left(COALESCE(NULLIF(trim(p_file_name), ''), 'documento'), 200), v_mime, v_size)
  RETURNING id INTO v_id;

  -- Empresa rechazada que ya no tiene documentos rechazados: vuelve a revisión
  IF EXISTS (SELECT 1 FROM public.users WHERE id = v_uid AND verification_status = 'rejected')
     AND NOT EXISTS (SELECT 1 FROM public.business_documents
                      WHERE user_id = v_uid AND status = 'rejected') THEN
    UPDATE public.users
       SET verification_status = 'pending', status_reason = NULL, updated_at = now()
     WHERE id = v_uid;
    UPDATE public.accounts
       SET status_reason = 'pending_approval'
     WHERE user_id = v_uid AND status = 'blocked' AND status_reason = 'account_rejected';
    RETURN jsonb_build_object('success', true, 'id', v_id, 'resubmitted', true);
  END IF;

  RETURN jsonb_build_object('success', true, 'id', v_id);
END;
$function$;
