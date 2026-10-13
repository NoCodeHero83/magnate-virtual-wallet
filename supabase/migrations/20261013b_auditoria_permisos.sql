-- =============================================================================
-- Auditoría de seguridad (2026-10-13): permisos de la base
--
-- Muchas funciones SECURITY DEFINER del esquema original conservaban el EXECUTE por
-- defecto para anon y authenticated y aceptaban un p_user_id sin compararlo con
-- auth.uid(). Las que no usa ningún cliente quedan solo para service_role (las
-- llamadas internas desde otras funciones SECURITY DEFINER y pg_cron siguen
-- funcionando porque corren como el dueño).
-- =============================================================================

-- 1. Funciones que ningún cliente debe ejecutar ------------------------------
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    -- Cola de correos: contiene los códigos de un solo uso en texto plano
    'public.read_queue_messages(text, integer, integer)',
    'public.delete_queue_message(text, bigint)',
    -- Límites de gasto y saldos (las corre pg_cron como postgres)
    'public.reset_daily_limits()',
    'public.reset_monthly_limits()',
    'public.reconcile_account_balance(uuid)',
    'public.reconcile_all_accounts()',
    'public.calculate_account_balance(uuid)',
    'public.create_daily_balance_snapshots()',
    'public.get_balance_at_date(uuid, date)',
    'public.get_balance_inconsistencies()',
    'public.monitor_balance_inconsistencies()',
    'public.monitor_negative_balances()',
    -- Mantenimiento
    'public.archive_old_api_logs()',
    'public.cleanup_inactive_devices()',
    'public.deactivate_expired_qr_codes()',
    'public.create_user_bank_account(uuid)',
    -- Dispositivos de cualquier usuario (reemplazadas por revoke_device, claim_onesignal_device, _trust_device)
    'public.upsert_user_device(text, text, text, text, text, text, text, text)',
    'public.revoke_user_device(text, uuid)',
    'public.revoke_all_other_devices(text, text)',
    'public.get_user_devices_list(text, text)',
    'public.check_device_registered(text, text)',
    'public.claim_device(text, text, jsonb)',
    'public.get_active_push_devices(uuid)',
    -- Datos de otros usuarios
    'public.get_user_id_from_account(uuid)',
    'public.check_user_exists(text, text, text)',
    -- Correos "oficiales" a cualquier usuario (la usan las funciones del servidor)
    'public.enqueue_notification(uuid, text, jsonb, uuid)'
  ] LOOP
    IF to_regprocedure(f) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

-- net.http_* no deben poder ejecutarse desde la API
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA net FROM anon, authenticated;

-- 2. get_account_info: solo la cuenta propia -----------------------------------
CREATE OR REPLACE FUNCTION public.get_account_info(p_user_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(account_id uuid, user_id uuid, cbu character varying, cvu character varying, alias character varying, balance numeric, status character varying, is_primary boolean, monthly_limit numeric, monthly_spent numeric, monthly_available numeric, daily_limit numeric, daily_spent numeric, qr_code_hash character varying, qr_code_data text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Antes devolvía CBU, CVU y saldo del p_user_id recibido, sin sesión.
  -- p_user_id se mantiene por compatibilidad: solo puede ser el propio usuario.
  IF auth.uid() IS NULL OR (p_user_id IS NOT NULL AND p_user_id <> auth.uid()) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.id AS account_id,
    a.user_id,
    a.cbu,
    a.cvu,
    a.alias,
    a.balance,
    a.status,
    a.is_primary,
    al.monthly_limit,
    al.monthly_spent,
    al.monthly_available,
    al.daily_limit,
    al.daily_spent,
    qr.qr_hash AS qr_code_hash,
    qr.qr_data AS qr_code_data,
    a.created_at
  FROM accounts a
  LEFT JOIN account_limits al ON al.account_id = a.id
  LEFT JOIN qr_codes qr ON qr.account_id = a.id AND qr.qr_type = 'static' AND qr.is_active = true
  WHERE a.user_id = auth.uid()
    AND a.status = 'active'
  LIMIT 1;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_account_info(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_info(uuid) TO authenticated, service_role;

-- 3. Plantillas de correo: las podía reescribir cualquiera sin sesión ------------
ALTER TABLE public.notification_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_types FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_types TO authenticated;
DROP POLICY IF EXISTS "Admins manage notification types" ON public.notification_types;
CREATE POLICY "Admins manage notification types" ON public.notification_types
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 4. Control interno del worker ---------------------------------------------------
ALTER TABLE public.worker_invocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_invocations FROM anon, authenticated;

-- 5. Contacto de soporte: cualquier usuario lo podía cambiar ------------------------
DROP POLICY IF EXISTS "Allow authenticated update access" ON public.support;
DROP POLICY IF EXISTS "Admins update support" ON public.support;
CREATE POLICY "Admins update support" ON public.support
  FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.support FROM anon;

-- 6. Acceso API: el usuario podía habilitarse solo y cambiar IPs / límites --------
-- api-setup escribe con service_role; el usuario solo lee lo suyo.
DROP POLICY IF EXISTS "Users can insert own API access" ON public.api_access;
DROP POLICY IF EXISTS "Users can update own API access" ON public.api_access;

-- 7. Dispositivos: el usuario no puede marcarse uno como de confianza ---------------
CREATE OR REPLACE FUNCTION public.protect_user_device_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
BEGIN
  -- Solo aplica a llamadas directas desde la API. _trust_device, claim_onesignal_device
  -- y revoke_device son SECURITY DEFINER y no pasan por aquí.
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.trusted_at IS NOT NULL OR NEW.secret_hash IS NOT NULL THEN
        RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos del dispositivo';
      END IF;
    ELSIF NEW.trusted_at IS DISTINCT FROM OLD.trusted_at
       OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
      RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos del dispositivo';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS protect_user_device_columns ON public.user_devices;
CREATE TRIGGER protect_user_device_columns
  BEFORE INSERT OR UPDATE ON public.user_devices
  FOR EACH ROW EXECUTE FUNCTION public.protect_user_device_columns();

-- 8. Bucket images: cualquiera (sin sesión) podía subir, reemplazar o borrar -------
-- Las fotos de perfil van en images/profiles/{user_id}/...
DROP POLICY IF EXISTS "all 1ffg0oo_1" ON storage.objects;
DROP POLICY IF EXISTS "all 1ffg0oo_2" ON storage.objects;
DROP POLICY IF EXISTS "all 1ffg0oo_3" ON storage.objects;
DROP POLICY IF EXISTS "Users upload own profile images" ON storage.objects;
DROP POLICY IF EXISTS "Users update own profile images" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own profile images" ON storage.objects;
CREATE POLICY "Users upload own profile images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'images' AND (storage.foldername(name))[1] = 'profiles'
              AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "Users update own profile images" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'images' AND (storage.foldername(name))[1] = 'profiles'
         AND (storage.foldername(name))[2] = auth.uid()::text)
  WITH CHECK (bucket_id = 'images' AND (storage.foldername(name))[1] = 'profiles'
              AND (storage.foldername(name))[2] = auth.uid()::text);
CREATE POLICY "Users delete own profile images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'images' AND (storage.foldername(name))[1] = 'profiles'
         AND (storage.foldername(name))[2] = auth.uid()::text);
