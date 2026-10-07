-- =============================================================================
-- Distribuidores (3 niveles) y comisiones configurables
-- Superadmin (role 'admin') -> Distribuidor (role 'distributor') -> Cliente (role 'user')
--
-- * La asignación a un distribuidor es por cuenta (CVU): accounts.distributor_id.
-- * Las comisiones salen de fee_rules (regla por CVU o, si no hay, la regla por defecto)
--   por tipo de operación:
--     payin        dinero que entra desde fuera de la billetera (Coinag, a futuro)
--     payout       dinero que sale fuera de la billetera (transferencia externa)
--     internal_out transferencia interna, la paga quien envía
--     internal_in  transferencia interna, la paga quien recibe
-- * charge_mode: 'deduct' sale del monto; 'on_top' se cobra aparte (solo operaciones salientes).
-- * La comisión se acredita en cuentas internas de comisiones (accounts.purpose = 'commission'):
--   una de Magnate y una por distribuidor. El reparto es magnate_share_percent.
-- * Las reglas arrancan en 0%: nada cambia hasta que el admin configure.
-- =============================================================================

-- =============================================================================
-- 0. Falla encontrada: los usuarios podían modificar su propia cuenta bancaria
--    (saldo, estado) y crear cuentas / límites desde el cliente.
-- =============================================================================
DROP POLICY IF EXISTS "Users can insert own accounts" ON public.accounts;
DROP POLICY IF EXISTS "Users can insert own account limits" ON public.account_limits;
DROP POLICY IF EXISTS "Users can insert own transactions" ON public.transactions;

CREATE OR REPLACE FUNCTION public.protect_account_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
BEGIN
  -- Desde la API (anon / authenticated) el usuario solo puede cambiar su alias.
  -- Las funciones SECURITY DEFINER y el service_role no pasan por aquí.
  IF current_user IN ('anon', 'authenticated') THEN
    IF OLD.purpose <> 'customer'
       OR (to_jsonb(NEW) - 'alias' - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'alias' - 'updated_at') THEN
      RAISE EXCEPTION 'FORBIDDEN: No tienes permisos para modificar estos datos de la cuenta';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 1. Roles y distribuidores
-- =============================================================================
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_role_check CHECK (role IN ('user', 'admin', 'distributor'));

CREATE TABLE IF NOT EXISTS public.distributors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE REFERENCES public.users(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  cuit text,
  contact_email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  commission_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS distributor_id uuid REFERENCES public.distributors(id) ON DELETE SET NULL;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_purpose_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_purpose_check CHECK (purpose IN ('customer', 'commission'));

-- Las cuentas de comisiones no tienen un usuario dueño (son de Magnate o de un distribuidor)
ALTER TABLE public.accounts ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_owner_check;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_owner_check
  CHECK (purpose = 'commission' OR user_id IS NOT NULL);
ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_commission_no_distributor;
ALTER TABLE public.accounts ADD CONSTRAINT accounts_commission_no_distributor
  CHECK (purpose = 'customer' OR distributor_id IS NULL);

ALTER TABLE public.distributors DROP CONSTRAINT IF EXISTS distributors_commission_account_fkey;
ALTER TABLE public.distributors ADD CONSTRAINT distributors_commission_account_fkey
  FOREIGN KEY (commission_account_id) REFERENCES public.accounts(id);

CREATE INDEX IF NOT EXISTS idx_accounts_distributor ON public.accounts(distributor_id) WHERE distributor_id IS NOT NULL;

DROP TRIGGER IF EXISTS protect_account_columns ON public.accounts;
CREATE TRIGGER protect_account_columns
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.protect_account_columns();

CREATE TABLE IF NOT EXISTS public.account_distributor_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  old_distributor_id uuid REFERENCES public.distributors(id) ON DELETE SET NULL,
  new_distributor_id uuid REFERENCES public.distributors(id) ON DELETE SET NULL,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_distributor_history_account ON public.account_distributor_history(account_id, changed_at DESC);

CREATE OR REPLACE FUNCTION public.is_distributor()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'distributor');
$$;

CREATE OR REPLACE FUNCTION public.current_distributor_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.id
    FROM public.distributors d
    JOIN public.users u ON u.id = d.user_id
   WHERE d.user_id = auth.uid() AND u.role = 'distributor';
$$;

ALTER TABLE public.distributors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_distributor_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage distributors" ON public.distributors;
CREATE POLICY "Admins manage distributors" ON public.distributors
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Distributor reads own row" ON public.distributors;
CREATE POLICY "Distributor reads own row" ON public.distributors
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Admins read assignment history" ON public.account_distributor_history;
CREATE POLICY "Admins read assignment history" ON public.account_distributor_history
  FOR SELECT TO authenticated USING (public.is_admin());

REVOKE ALL ON public.distributors, public.account_distributor_history FROM anon;

-- =============================================================================
-- 2. Cuentas de comisiones
-- =============================================================================
CREATE OR REPLACE FUNCTION public._create_commission_account(p_alias text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $$
DECLARE
  v_type_id uuid;
  v_id uuid;
BEGIN
  SELECT id INTO v_type_id FROM public.account_types WHERE code = 'savings_ars' AND is_active LIMIT 1;
  IF v_type_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_TYPE_NOT_FOUND';
  END IF;

  INSERT INTO public.accounts (user_id, account_type_id, cbu, cvu, alias, balance, status, is_primary, purpose)
  VALUES (NULL, v_type_id, public.generate_unique_cbu(), public.generate_unique_cvu(), p_alias, 0, 'active', false, 'commission')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._create_commission_account(text) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.app_settings WHERE key = 'magnate_commission_account_id') THEN
    v_id := public._create_commission_account('magnate.comisiones');
    INSERT INTO public.app_settings (key, value, updated_at)
    VALUES ('magnate_commission_account_id', to_jsonb(v_id::text), now());
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._magnate_commission_account_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT (value #>> '{}')::uuid FROM public.app_settings WHERE key = 'magnate_commission_account_id';
$$;
REVOKE ALL ON FUNCTION public._magnate_commission_account_id() FROM PUBLIC, anon, authenticated;

-- Nombre del titular: las cuentas de comisiones no tienen usuario
CREATE OR REPLACE FUNCTION public.account_holder_name(p_account_id uuid)
RETURNS character varying
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT (CASE
            WHEN a.purpose = 'commission' THEN
              COALESCE((SELECT 'Comisiones ' || d.name FROM public.distributors d WHERE d.commission_account_id = a.id),
                       'Magnate')
            ELSE public.user_holder_name(a.user_id)
          END)::varchar
    FROM public.accounts a
   WHERE a.id = p_account_id;
$$;

-- =============================================================================
-- 3. Reglas de comisión
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.fee_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('payin', 'payout', 'internal_out', 'internal_in')),
  rate_percent numeric(7,4) NOT NULL DEFAULT 0 CHECK (rate_percent >= 0 AND rate_percent <= 100),
  fixed_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (fixed_amount >= 0),
  min_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  max_amount numeric(14,2) CHECK (max_amount IS NULL OR max_amount >= min_amount),
  charge_mode text NOT NULL DEFAULT 'deduct' CHECK (charge_mode IN ('deduct', 'on_top')),
  magnate_share_percent numeric(5,2) NOT NULL DEFAULT 100 CHECK (magnate_share_percent >= 0 AND magnate_share_percent <= 100),
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  -- Lo que entra siempre se descuenta de lo recibido
  CONSTRAINT fee_rules_incoming_deduct CHECK (operation IN ('payout', 'internal_out') OR charge_mode = 'deduct')
);
CREATE UNIQUE INDEX IF NOT EXISTS fee_rules_default_uq ON public.fee_rules(operation) WHERE account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fee_rules_account_uq ON public.fee_rules(account_id, operation) WHERE account_id IS NOT NULL;

INSERT INTO public.fee_rules (account_id, operation, charge_mode)
VALUES (NULL, 'payin', 'deduct'), (NULL, 'payout', 'on_top'),
       (NULL, 'internal_out', 'on_top'), (NULL, 'internal_in', 'deduct')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.fee_rules_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  NEW.updated_by := auth.uid();
  IF NEW.account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.accounts WHERE id = NEW.account_id AND purpose = 'customer'
  ) THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT: Solo se configuran comisiones para cuentas de clientes';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS fee_rules_touch ON public.fee_rules;
CREATE TRIGGER fee_rules_touch BEFORE INSERT OR UPDATE ON public.fee_rules
  FOR EACH ROW EXECUTE FUNCTION public.fee_rules_touch();

-- Las reglas por defecto no se borran (se ponen en 0)
CREATE OR REPLACE FUNCTION public.fee_rules_keep_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.account_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: Las reglas por defecto no se pueden borrar';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS fee_rules_keep_defaults ON public.fee_rules;
CREATE TRIGGER fee_rules_keep_defaults BEFORE DELETE ON public.fee_rules
  FOR EACH ROW EXECUTE FUNCTION public.fee_rules_keep_defaults();

ALTER TABLE public.fee_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read fee rules" ON public.fee_rules;
CREATE POLICY "Admins read fee rules" ON public.fee_rules FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Admins insert fee rules" ON public.fee_rules;
CREATE POLICY "Admins insert fee rules" ON public.fee_rules FOR INSERT TO authenticated WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "Admins update fee rules" ON public.fee_rules;
CREATE POLICY "Admins update fee rules" ON public.fee_rules FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
DROP POLICY IF EXISTS "Admins delete fee rules" ON public.fee_rules;
CREATE POLICY "Admins delete fee rules" ON public.fee_rules FOR DELETE TO authenticated USING (public.is_admin());
REVOKE ALL ON public.fee_rules FROM anon;

-- Regla aplicable: la del CVU si existe y está activa; si no, la por defecto
CREATE OR REPLACE FUNCTION public._fee_rule(p_account_id uuid, p_operation text)
RETURNS public.fee_rules
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT r.*
    FROM public.fee_rules r
   WHERE r.operation = p_operation
     AND r.is_active
     AND (r.account_id = p_account_id OR r.account_id IS NULL)
   ORDER BY (r.account_id IS NULL)
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public._fee_amount(p_rule public.fee_rules, p_amount numeric)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_fee numeric;
BEGIN
  IF p_rule.id IS NULL OR (p_rule.rate_percent = 0 AND p_rule.fixed_amount = 0) THEN
    RETURN 0;
  END IF;
  v_fee := round(p_amount * p_rule.rate_percent / 100 + p_rule.fixed_amount, 2);
  v_fee := greatest(v_fee, p_rule.min_amount);
  IF p_rule.max_amount IS NOT NULL THEN
    v_fee := least(v_fee, p_rule.max_amount);
  END IF;
  RETURN v_fee;
END;
$$;
REVOKE ALL ON FUNCTION public._fee_rule(uuid, text) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 4. Registro de comisiones
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.commission_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.transactions(id),
  related_transaction_id uuid REFERENCES public.transactions(id),
  payer_account_id uuid NOT NULL REFERENCES public.accounts(id),
  distributor_id uuid REFERENCES public.distributors(id) ON DELETE SET NULL,
  operation text NOT NULL,
  base_amount numeric(14,2) NOT NULL,
  rate_percent numeric(7,4) NOT NULL,
  fixed_amount numeric(14,2) NOT NULL,
  charge_mode text NOT NULL,
  fee_total numeric(14,2) NOT NULL CHECK (fee_total > 0),
  magnate_amount numeric(14,2) NOT NULL,
  distributor_amount numeric(14,2) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (magnate_amount + distributor_amount = fee_total)
);
CREATE INDEX IF NOT EXISTS idx_commission_entries_created ON public.commission_entries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_entries_distributor ON public.commission_entries(distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commission_entries_payer ON public.commission_entries(payer_account_id, created_at DESC);

ALTER TABLE public.commission_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Admins read commissions" ON public.commission_entries;
CREATE POLICY "Admins read commissions" ON public.commission_entries
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Distributor reads own commissions" ON public.commission_entries;
CREATE POLICY "Distributor reads own commissions" ON public.commission_entries
  FOR SELECT TO authenticated USING (distributor_id IS NOT NULL AND distributor_id = public.current_distributor_id());
REVOKE ALL ON public.commission_entries FROM anon;

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

  IF v_distributor.id IS NOT NULL AND v_distributor.commission_account_id IS NOT NULL THEN
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
    v_distributor.id,
    p_operation, p_base_amount, p_rule.rate_percent, p_rule.fixed_amount, p_rule.charge_mode,
    p_fee, p_fee - v_dist_amount, v_dist_amount
  );

  RETURN v_tx_id;
END;
$$;
REVOKE ALL ON FUNCTION public._charge_commission(uuid, text, numeric, public.fee_rules, numeric, uuid, text) FROM PUBLIC, anon, authenticated;

-- Las comisiones no generan notificaciones push/email (se ven en los movimientos).
-- Se parchea la función existente sin reescribirla, porque contiene el secreto del worker.
DO $$
DECLARE
  v_def text := pg_get_functiondef('public.trigger_enqueue_transaction_notification'::regproc);
  v_new text;
BEGIN
  IF position('commission_skip' IN v_def) > 0 THEN
    RETURN;
  END IF;
  v_new := replace(v_def,
    'IF NEW.status = ''completed'' THEN',
    'IF NEW.status = ''completed'' AND NOT EXISTS ( /* commission_skip */ SELECT 1 FROM public.transaction_types x WHERE x.id = NEW.transaction_type_id AND x.code = ''commission'') THEN');
  IF v_new = v_def THEN
    RAISE EXCEPTION 'No se pudo parchear trigger_enqueue_transaction_notification';
  END IF;
  EXECUTE v_new;
END $$;

-- =============================================================================
-- 5. Cotización (lo que la app y la web muestran antes de confirmar)
-- =============================================================================
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
  v_owner uuid;
  v_is_external boolean;
  v_operation text;
  v_rule public.fee_rules;
  v_fee numeric;
BEGIN
  SELECT user_id INTO v_owner FROM public.accounts WHERE id = p_from_account_id AND purpose = 'customer';
  IF v_owner IS NULL OR v_owner <> auth.uid() THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_AMOUNT');
  END IF;

  v_is_external := NOT EXISTS (
    SELECT 1 FROM public.accounts
     WHERE LOWER(alias) = LOWER(p_to_identifier) OR cvu = p_to_identifier OR cbu = p_to_identifier
  );
  v_operation := CASE WHEN v_is_external THEN 'payout' ELSE 'internal_out' END;
  v_rule := public._fee_rule(p_from_account_id, v_operation);
  v_fee := public._fee_amount(v_rule, p_amount);

  RETURN jsonb_build_object(
    'success', true,
    'operation', v_operation,
    'amount', p_amount,
    'fee', v_fee,
    'charge_mode', COALESCE(v_rule.charge_mode, 'deduct'),
    'total_debit', CASE WHEN v_rule.charge_mode = 'on_top' THEN p_amount + v_fee ELSE p_amount END,
    'amount_sent', CASE WHEN v_rule.charge_mode = 'on_top' THEN p_amount ELSE p_amount - v_fee END
  );
END;
$$;
REVOKE ALL ON FUNCTION public.quote_transfer(uuid, character varying, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.quote_transfer(uuid, character varying, numeric) TO authenticated;

-- =============================================================================
-- 6. process_transfer con comisiones
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
    (LOWER(alias) = LOWER(p_to_identifier) OR cvu = p_to_identifier OR cbu = p_to_identifier)
    AND status = 'active'
    AND purpose = 'customer'
  FOR UPDATE;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM accounts
      WHERE (LOWER(alias) = LOWER(p_to_identifier) OR cvu = p_to_identifier OR cbu = p_to_identifier)
    ) THEN
      RAISE EXCEPTION 'DESTINATION_NOT_ACTIVE: La cuenta destino no está habilitada para recibir transferencias';
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
    CASE WHEN v_is_external AND p_payment_method = 'cvu' THEN p_to_identifier ELSE NULL END,
    CASE WHEN v_is_external AND p_payment_method = 'cbu' THEN p_to_identifier ELSE NULL END,
    CASE WHEN v_is_external AND p_payment_method = 'alias' THEN p_to_identifier ELSE NULL END,
    CASE WHEN v_is_external THEN v_external_holder ELSE NULL END,
    v_principal, 'ARS', p_concept, p_payment_method, p_to_identifier, 'completed',
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
      v_principal, 'ARS', p_concept, p_payment_method, p_to_identifier, 'completed',
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

-- Las cuentas de comisiones no aparecen como destino
CREATE OR REPLACE FUNCTION public.search_account_for_transfer(p_identifier character varying)
RETURNS TABLE(account_id uuid, holder_name character varying, alias character varying, is_external boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    a.id as account_id,
    public.user_holder_name(a.user_id) as holder_name,
    a.alias,
    false as is_external
  FROM accounts a
  WHERE a.status = 'active'
    AND a.purpose = 'customer'
    AND (
      LOWER(a.alias) = LOWER(p_identifier)
      OR a.cbu = p_identifier
      OR a.cvu = p_identifier
    )
  LIMIT 1;

  IF NOT FOUND AND p_identifier ~ '^\d{22}$'
     AND NOT EXISTS (SELECT 1 FROM accounts WHERE cbu = p_identifier OR cvu = p_identifier) THEN
    RETURN QUERY
    SELECT
      NULL::UUID as account_id,
      CAST('Cuenta Externa' AS VARCHAR) as holder_name,
      NULL::VARCHAR as alias,
      true as is_external;
  END IF;
END;
$function$;

-- =============================================================================
-- 7. Login de distribuidores
--    El alta la hace la edge function admin-create-distributor con service_role:
--    primero registra el email en staff_invites y después crea el usuario de auth.
--    handle_new_user reconoce la invitación y lo registra como distribuidor.
--    (GoTrue guarda app_metadata después del INSERT, por eso no se usa app_metadata.)
--    staff_invites no tiene políticas: solo el service_role puede escribirla.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.staff_invites (
  email text PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('distributor')),
  distributor_id uuid REFERENCES public.distributors(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz
);
ALTER TABLE public.staff_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.staff_invites FROM anon, authenticated;

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
  v_staff_role text;
  v_staff_key text;
BEGIN
  -- Usuario del panel (distribuidor): sin cuenta bancaria, sin DNI ni PIN.
  -- Solo si el servidor registró la invitación en los últimos 10 minutos.
  UPDATE public.staff_invites
     SET consumed_at = now()
   WHERE email = lower(NEW.email)
     AND consumed_at IS NULL
     AND created_at > now() - interval '10 minutes'
  RETURNING role INTO v_staff_role;

  IF v_staff_role = 'distributor' THEN
    -- dni / cuit_cuil son únicos y de 20 caracteres
    v_staff_key := 'S' || substr(replace(NEW.id::text, '-', ''), 1, 19);
    INSERT INTO public.users (
      id, email, first_name, last_name, phone, dni, cuit_cuil, pin_hash,
      verification_status, account_type, role, web_access_enabled, created_at, updated_at
    ) VALUES (
      NEW.id, NEW.email,
      COALESCE(NULLIF(v_meta->>'first_name', ''), 'Distribuidor'),
      COALESCE(NULLIF(v_meta->>'last_name', ''), ''),
      '0000000000', v_staff_key, v_staff_key, 'NO_PIN',
      'verified', 'personal', 'distributor', false, NOW(), NOW()
    );
    RETURN NEW;
  END IF;

  RAISE LOG 'Trigger handle_new_user ejecutándose para: % (tipo %)', NEW.email, v_account_type;

  IF v_account_type NOT IN ('personal', 'business') THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT_TYPE: %', v_account_type;
  END IF;

  IF public.get_setting_bool('require_signup_email_otp', false)
     AND NOT public.signup_email_verified(NEW.email) THEN
    RAISE EXCEPTION 'EMAIL_NOT_VERIFIED: Debes verificar tu email antes de crear la cuenta';
  END IF;

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

  UPDATE auth.users SET raw_user_meta_data = raw_user_meta_data - 'pin_hash' WHERE id = NEW.id;

  RAISE LOG 'Usuario creado en public.users: % (tipo %, estado %)', NEW.id, v_account_type, v_status;
  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE LOG 'ERROR EN TRIGGER handle_new_user: %', SQLERRM;
    RAISE EXCEPTION 'Error creando perfil de usuario: %', SQLERRM;
END;
$function$;

-- Solo los clientes tienen cuenta bancaria
CREATE OR REPLACE FUNCTION public.trigger_create_account_on_user_signup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_result JSONB;
BEGIN
  IF NEW.role <> 'user' THEN
    RETURN NEW;
  END IF;

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

-- =============================================================================
-- 8. RPCs de administración
-- =============================================================================
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
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN: Solo un administrador puede gestionar distribuidores';
  END IF;
  IF p_name IS NULL OR length(trim(p_name)) < 2 THEN
    RAISE EXCEPTION 'INVALID_NAME: Ingresa el nombre del distribuidor';
  END IF;
  IF v_cuit IS NOT NULL AND length(v_cuit) <> 11 THEN
    RAISE EXCEPTION 'INVALID_CUIT: El CUIT debe tener 11 dígitos';
  END IF;
  IF p_status NOT IN ('active', 'inactive') THEN
    RAISE EXCEPTION 'INVALID_STATUS';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO public.distributors (name, cuit, contact_email, status, created_by)
    VALUES (trim(p_name), v_cuit, NULLIF(trim(lower(p_contact_email)), ''), p_status, auth.uid())
    RETURNING id INTO v_id;

    v_acc := public._create_commission_account('comisiones.' || substr(replace(v_id::text, '-', ''), 1, 10));
    UPDATE public.distributors SET commission_account_id = v_acc WHERE id = v_id;
  ELSE
    UPDATE public.distributors
       SET name = trim(p_name), cuit = v_cuit,
           contact_email = NULLIF(trim(lower(p_contact_email)), ''),
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

-- Asigna (o quita, con p_distributor_id = NULL) un lote de CVUs a un distribuidor
CREATE OR REPLACE FUNCTION public.admin_assign_accounts(p_account_ids uuid[], p_distributor_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN: Solo un administrador puede asignar cuentas';
  END IF;
  IF p_distributor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.distributors WHERE id = p_distributor_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'INVALID_DISTRIBUTOR: El distribuidor no existe o está inactivo';
  END IF;

  INSERT INTO public.account_distributor_history (account_id, old_distributor_id, new_distributor_id, changed_by)
  SELECT a.id, a.distributor_id, p_distributor_id, auth.uid()
    FROM public.accounts a
   WHERE a.id = ANY(p_account_ids)
     AND a.purpose = 'customer'
     AND a.distributor_id IS DISTINCT FROM p_distributor_id;

  UPDATE public.accounts a
     SET distributor_id = p_distributor_id, updated_at = now()
   WHERE a.id = ANY(p_account_ids)
     AND a.purpose = 'customer'
     AND a.distributor_id IS DISTINCT FROM p_distributor_id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_assign_accounts(uuid[], uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_accounts(uuid[], uuid) TO authenticated;

-- Lista de distribuidores con métricas (admin)
CREATE OR REPLACE FUNCTION public.admin_distributor_list()
RETURNS TABLE (
  id uuid, name text, cuit text, contact_email text, status text, created_at timestamptz,
  user_id uuid, login_email text, accounts_count bigint, commission_balance numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN QUERY
  SELECT d.id, d.name, d.cuit, d.contact_email, d.status, d.created_at,
         d.user_id, u.email::text,
         (SELECT count(*) FROM public.accounts a WHERE a.distributor_id = d.id),
         COALESCE(ca.balance, 0)
    FROM public.distributors d
    LEFT JOIN public.users u ON u.id = d.user_id
    LEFT JOIN public.accounts ca ON ca.id = d.commission_account_id
   ORDER BY d.name;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_distributor_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_distributor_list() TO authenticated;

-- Resumen de comisiones del período (admin)
CREATE OR REPLACE FUNCTION public.admin_commission_summary(p_from timestamptz, p_to timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'fee_total', COALESCE(sum(fee_total), 0),
      'magnate_total', COALESCE(sum(magnate_amount), 0),
      'distributor_total', COALESCE(sum(distributor_amount), 0),
      'count', count(*),
      'magnate_balance', (SELECT balance FROM public.accounts WHERE id = public._magnate_commission_account_id())
    )
    FROM public.commission_entries
    WHERE created_at >= p_from AND created_at < p_to
  );
END;
$$;
REVOKE ALL ON FUNCTION public.admin_commission_summary(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_commission_summary(timestamptz, timestamptz) TO authenticated;

-- =============================================================================
-- 9. Panel del distribuidor (también lo usa el admin, pasando p_distributor_id)
-- =============================================================================
CREATE OR REPLACE FUNCTION public._resolve_distributor(p_distributor_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF public.is_admin() THEN
    RETURN p_distributor_id;
  END IF;
  RETURN public.current_distributor_id();
END;
$$;
REVOKE ALL ON FUNCTION public._resolve_distributor(uuid) FROM PUBLIC, anon, authenticated;

-- Volumen y comisiones por CVU en el período. Para un distribuidor, solo sus CVUs.
-- Para el admin: p_distributor_id NULL = todas las cuentas asignadas a algún distribuidor.
CREATE OR REPLACE FUNCTION public.distributor_account_volume(
  p_from timestamptz,
  p_to timestamptz,
  p_distributor_id uuid DEFAULT NULL
)
RETURNS TABLE (
  account_id uuid, distributor_id uuid, distributor_name text, holder_name text,
  cvu text, alias text, account_status text, account_type text,
  volume_in numeric, volume_out numeric, operations bigint,
  fee_total numeric, distributor_amount numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dist uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_distributor()) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  v_dist := public._resolve_distributor(p_distributor_id);
  IF NOT public.is_admin() AND v_dist IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  RETURN QUERY
  WITH accs AS (
    SELECT a.* FROM public.accounts a
     WHERE a.purpose = 'customer'
       AND a.distributor_id IS NOT NULL
       AND (v_dist IS NULL OR a.distributor_id = v_dist)
  ),
  mv AS (
    SELECT acc.id AS account_id,
           sum(CASE WHEN t.to_account_id = acc.id THEN t.amount ELSE 0 END) AS v_in,
           sum(CASE WHEN t.from_account_id = acc.id THEN t.amount ELSE 0 END) AS v_out,
           count(t.id) AS ops
      FROM accs acc
      JOIN public.transactions t ON (t.to_account_id = acc.id OR t.from_account_id = acc.id)
      JOIN public.transaction_types tt ON tt.id = t.transaction_type_id
     WHERE t.status = 'completed' AND tt.code <> 'commission'
       AND t.created_at >= p_from AND t.created_at < p_to
     GROUP BY acc.id
  ),
  fees AS (
    SELECT ce.payer_account_id AS account_id,
           sum(ce.fee_total) AS fee_total,
           sum(ce.distributor_amount) AS dist_amount
      FROM public.commission_entries ce
     WHERE ce.created_at >= p_from AND ce.created_at < p_to
       AND ce.payer_account_id IN (SELECT id FROM accs)
     GROUP BY ce.payer_account_id
  )
  SELECT acc.id, acc.distributor_id, d.name,
         public.user_holder_name(acc.user_id)::text,
         acc.cvu::text, acc.alias::text, acc.status::text, u.account_type,
         COALESCE(mv.v_in, 0), COALESCE(mv.v_out, 0), COALESCE(mv.ops, 0),
         COALESCE(fees.fee_total, 0), COALESCE(fees.dist_amount, 0)
    FROM accs acc
    JOIN public.distributors d ON d.id = acc.distributor_id
    LEFT JOIN public.users u ON u.id = acc.user_id
    LEFT JOIN mv ON mv.account_id = acc.id
    LEFT JOIN fees ON fees.account_id = acc.id
   ORDER BY COALESCE(mv.v_in, 0) + COALESCE(mv.v_out, 0) DESC, acc.alias;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_account_volume(timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_account_volume(timestamptz, timestamptz, uuid) TO authenticated;

-- Detalle de comisiones del distribuidor
CREATE OR REPLACE FUNCTION public.distributor_commission_detail(
  p_from timestamptz,
  p_to timestamptz,
  p_distributor_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid, created_at timestamptz, operation text, holder_name text, cvu text, alias text,
  base_amount numeric, rate_percent numeric, fee_total numeric,
  magnate_amount numeric, distributor_amount numeric, distributor_name text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dist uuid;
BEGIN
  IF NOT (public.is_admin() OR public.is_distributor()) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  v_dist := public._resolve_distributor(p_distributor_id);
  IF NOT public.is_admin() AND v_dist IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  RETURN QUERY
  SELECT ce.id, ce.created_at, ce.operation,
         public.user_holder_name(a.user_id)::text, a.cvu::text, a.alias::text,
         ce.base_amount, ce.rate_percent, ce.fee_total,
         ce.magnate_amount, ce.distributor_amount, d.name
    FROM public.commission_entries ce
    JOIN public.accounts a ON a.id = ce.payer_account_id
    LEFT JOIN public.distributors d ON d.id = ce.distributor_id
   WHERE ce.created_at >= p_from AND ce.created_at < p_to
     AND (v_dist IS NULL OR ce.distributor_id = v_dist)
   ORDER BY ce.created_at DESC
   LIMIT least(greatest(COALESCE(p_limit, 500), 1), 5000);
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_commission_detail(timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_commission_detail(timestamptz, timestamptz, uuid, integer) TO authenticated;

-- Datos del distribuidor que entra al panel
CREATE OR REPLACE FUNCTION public.distributor_me()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_d public.distributors;
BEGIN
  SELECT * INTO v_d FROM public.distributors WHERE id = public.current_distributor_id();
  IF v_d.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'id', v_d.id, 'name', v_d.name, 'cuit', v_d.cuit, 'status', v_d.status,
    'accounts_count', (SELECT count(*) FROM public.accounts WHERE distributor_id = v_d.id),
    'commission_balance', (SELECT balance FROM public.accounts WHERE id = v_d.commission_account_id)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_me() TO authenticated;

-- =============================================================================
-- 10. Vista de usuarios del admin: distribuidor asignado y cuenta
-- =============================================================================
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
    u.zapsign_contract_url,
    a.id AS account_id,
    a.cvu AS account_cvu,
    a.alias AS account_alias,
    a.distributor_id,
    d.name AS distributor_name
   FROM users u
     LEFT JOIN business_profiles bp ON bp.user_id = u.id
     LEFT JOIN legal_entity_types let ON let.code = bp.legal_entity_type
     LEFT JOIN accounts a ON a.user_id = u.id AND a.purpose = 'customer'
     LEFT JOIN distributors d ON d.id = a.distributor_id;
