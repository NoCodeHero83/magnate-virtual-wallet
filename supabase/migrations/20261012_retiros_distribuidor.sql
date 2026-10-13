-- =============================================================================
-- Retiros de comisiones del distribuidor y movimientos de sus CVUs
--
-- * El distribuidor pide un retiro de su cuenta de comisiones, en pesos (a un
--   CBU/CVU/alias) o en USDT (a una wallet). El monto se pide siempre en pesos.
-- * Al pedirlo el monto queda reservado: disponible = saldo - retiros pendientes.
-- * El admin lo marca como pagado (el pago se hace por fuera de la plataforma y se
--   registra el comprobante / hash) o lo rechaza con un motivo. Al pagarlo se
--   debita la cuenta de comisiones con un movimiento de tipo 'withdrawal'.
-- * Configurable desde el admin: monto mínimo de retiro y cotización del USDT
--   (la del pedido es un estimado; al pagar el admin registra la real).
-- * distributor_movements: depósitos, retiros y transferencias de los CVUs del
--   distribuidor (el admin puede ver los de cualquiera).
-- =============================================================================

INSERT INTO public.transaction_types (code, name, description, category, is_active)
SELECT 'withdrawal', 'Retiro', 'Retiro de comisiones del distribuidor', 'expense', true
 WHERE NOT EXISTS (SELECT 1 FROM public.transaction_types WHERE code = 'withdrawal');

INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('withdrawal_min_amount', to_jsonb(0), now()), ('usdt_ars_rate', to_jsonb(0), now())
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- 1. Solicitudes de retiro
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.distributor_withdrawals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distributor_id uuid NOT NULL REFERENCES public.distributors(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.accounts(id),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency IN ('ARS', 'USDT')),
  -- ARS: {destination, holder_name}; USDT: {wallet, network}
  destination jsonb NOT NULL,
  usdt_rate_estimate numeric(15,4),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'rejected', 'cancelled')),
  requested_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  reject_reason text,
  payment_reference text,
  usdt_rate numeric(15,4),
  usdt_amount numeric(15,2),
  transaction_id uuid REFERENCES public.transactions(id)
);
CREATE INDEX IF NOT EXISTS distributor_withdrawals_distributor_idx
  ON public.distributor_withdrawals (distributor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS distributor_withdrawals_pending_idx
  ON public.distributor_withdrawals (status) WHERE status = 'pending';

ALTER TABLE public.distributor_withdrawals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.distributor_withdrawals FROM anon;
-- Sin políticas de escritura: todo pasa por las funciones de abajo
DROP POLICY IF EXISTS "Admins read withdrawals" ON public.distributor_withdrawals;
CREATE POLICY "Admins read withdrawals" ON public.distributor_withdrawals
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Distributor reads own withdrawals" ON public.distributor_withdrawals;
CREATE POLICY "Distributor reads own withdrawals" ON public.distributor_withdrawals
  FOR SELECT TO authenticated USING (distributor_id = public.current_distributor_id());

-- =============================================================================
-- 2. Configuración (monto mínimo y cotización del USDT)
-- =============================================================================
CREATE OR REPLACE FUNCTION public._setting_numeric(p_key text)
RETURNS numeric
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::numeric FROM public.app_settings WHERE key = p_key), 0);
$$;
REVOKE ALL ON FUNCTION public._setting_numeric(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.withdrawal_settings()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT (public.is_admin() OR public.is_distributor()) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN jsonb_build_object(
    'min_amount', public._setting_numeric('withdrawal_min_amount'),
    'usdt_rate', public._setting_numeric('usdt_ars_rate')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.withdrawal_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdrawal_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_withdrawal_settings(p_min_amount numeric, p_usdt_rate numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_min_amount IS NULL OR p_min_amount < 0 THEN
    RAISE EXCEPTION 'INVALID_MIN_AMOUNT: El monto mínimo no puede ser negativo';
  END IF;
  IF p_usdt_rate IS NULL OR p_usdt_rate < 0 THEN
    RAISE EXCEPTION 'INVALID_RATE: La cotización no puede ser negativa';
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at, updated_by)
  VALUES ('withdrawal_min_amount', to_jsonb(round(p_min_amount, 2)), now(), auth.uid()),
         ('usdt_ars_rate', to_jsonb(round(p_usdt_rate, 4)), now(), auth.uid())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_withdrawal_settings(numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_withdrawal_settings(numeric, numeric) TO authenticated;

-- =============================================================================
-- 3. Saldo del distribuidor: total, reservado (retiros pendientes) y disponible
-- =============================================================================
CREATE OR REPLACE FUNCTION public.distributor_balance(p_distributor_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dist uuid;
  v_balance numeric;
  v_reserved numeric;
BEGIN
  IF NOT (public.is_admin() OR public.is_distributor()) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  v_dist := public._resolve_distributor(p_distributor_id);
  IF v_dist IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT COALESCE(a.balance, 0) INTO v_balance
    FROM public.distributors d
    LEFT JOIN public.accounts a ON a.id = d.commission_account_id
   WHERE d.id = v_dist;
  SELECT COALESCE(sum(amount), 0) INTO v_reserved
    FROM public.distributor_withdrawals
   WHERE distributor_id = v_dist AND status = 'pending';

  RETURN jsonb_build_object(
    'balance', COALESCE(v_balance, 0),
    'reserved', v_reserved,
    'available', greatest(COALESCE(v_balance, 0) - v_reserved, 0),
    'paid_total', (SELECT COALESCE(sum(amount), 0) FROM public.distributor_withdrawals
                    WHERE distributor_id = v_dist AND status = 'paid')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_balance(uuid) TO authenticated;

-- =============================================================================
-- 4. El distribuidor pide un retiro / cancela uno pendiente
-- =============================================================================
CREATE OR REPLACE FUNCTION public.distributor_request_withdrawal(
  p_amount numeric,
  p_currency text,
  p_destination jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_d public.distributors;
  v_balance numeric;
  v_reserved numeric;
  v_min numeric := public._setting_numeric('withdrawal_min_amount');
  v_rate numeric := public._setting_numeric('usdt_ars_rate');
  v_dest jsonb;
  v_target text;
  v_id uuid;
BEGIN
  SELECT * INTO v_d FROM public.distributors WHERE id = public.current_distributor_id();
  IF v_d.id IS NULL OR v_d.commission_account_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  p_amount := round(p_amount, 2);
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: El monto debe ser mayor a 0';
  END IF;
  IF p_amount < v_min THEN
    RAISE EXCEPTION 'AMOUNT_BELOW_MINIMUM: El monto mínimo de retiro es $ %', to_char(v_min, 'FM999G999G990D00');
  END IF;

  IF p_currency = 'ARS' THEN
    v_target := lower(trim(COALESCE(p_destination->>'destination', '')));
    IF v_target !~ '^\d{22}$' AND v_target !~ '^[a-z0-9.\-]{6,20}$' THEN
      RAISE EXCEPTION 'INVALID_DESTINATION: Ingresa un CBU/CVU de 22 dígitos o un alias válido';
    END IF;
    v_dest := jsonb_build_object(
      'destination', v_target,
      'holder_name', left(trim(COALESCE(p_destination->>'holder_name', '')), 120)
    );
  ELSIF p_currency = 'USDT' THEN
    IF v_rate <= 0 THEN
      RAISE EXCEPTION 'USDT_NOT_AVAILABLE: Los retiros en USDT no están habilitados por el momento';
    END IF;
    v_target := trim(COALESCE(p_destination->>'wallet', ''));
    IF v_target !~ '^[A-Za-z0-9]{26,64}$' THEN
      RAISE EXCEPTION 'INVALID_WALLET: La dirección de la wallet no es válida';
    END IF;
    IF COALESCE(p_destination->>'network', '') NOT IN ('TRC20', 'ERC20', 'BEP20', 'POLYGON') THEN
      RAISE EXCEPTION 'INVALID_NETWORK: Elige la red de la wallet';
    END IF;
    v_dest := jsonb_build_object('wallet', v_target, 'network', p_destination->>'network');
  ELSE
    RAISE EXCEPTION 'INVALID_CURRENCY: La moneda debe ser ARS o USDT';
  END IF;

  -- Bloquea la cuenta de comisiones: dos pedidos a la vez no pueden reservar el mismo saldo
  SELECT balance INTO v_balance FROM public.accounts WHERE id = v_d.commission_account_id FOR UPDATE;
  SELECT COALESCE(sum(amount), 0) INTO v_reserved
    FROM public.distributor_withdrawals
   WHERE distributor_id = v_d.id AND status = 'pending';
  IF p_amount > COALESCE(v_balance, 0) - v_reserved THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: El monto supera tu saldo disponible';
  END IF;

  INSERT INTO public.distributor_withdrawals (
    distributor_id, account_id, amount, currency, destination, usdt_rate_estimate, requested_by
  ) VALUES (
    v_d.id, v_d.commission_account_id, p_amount, p_currency, v_dest,
    CASE WHEN p_currency = 'USDT' THEN v_rate END, auth.uid()
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_request_withdrawal(numeric, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_request_withdrawal(numeric, text, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.distributor_cancel_withdrawal(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE public.distributor_withdrawals
     SET status = 'cancelled', resolved_at = now(), resolved_by = auth.uid()
   WHERE id = p_id
     AND status = 'pending'
     AND distributor_id = public.current_distributor_id();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_PENDING: La solicitud ya no está pendiente';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_cancel_withdrawal(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_cancel_withdrawal(uuid) TO authenticated;

-- =============================================================================
-- 5. El admin marca un retiro como pagado o lo rechaza
-- =============================================================================
CREATE OR REPLACE FUNCTION public.admin_resolve_withdrawal(
  p_id uuid,
  p_action text,
  p_reference text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_usdt_rate numeric DEFAULT NULL,
  p_usdt_amount numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_w public.distributor_withdrawals;
  v_balance numeric;
  v_type_id uuid;
  v_tx_id uuid;
  v_rate numeric;
  v_usdt numeric;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT * INTO v_w FROM public.distributor_withdrawals WHERE id = p_id FOR UPDATE;
  IF v_w.id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: No existe la solicitud';
  END IF;
  IF v_w.status <> 'pending' THEN
    RAISE EXCEPTION 'NOT_PENDING: La solicitud ya no está pendiente';
  END IF;

  IF p_action = 'reject' THEN
    IF length(trim(COALESCE(p_reason, ''))) < 3 THEN
      RAISE EXCEPTION 'REASON_REQUIRED: Indica el motivo del rechazo';
    END IF;
    UPDATE public.distributor_withdrawals
       SET status = 'rejected', reject_reason = trim(p_reason), resolved_at = now(), resolved_by = auth.uid()
     WHERE id = p_id;
    RETURN;
  END IF;

  IF p_action <> 'pay' THEN
    RAISE EXCEPTION 'INVALID_ACTION';
  END IF;
  IF length(trim(COALESCE(p_reference, ''))) = 0 THEN
    RAISE EXCEPTION 'REFERENCE_REQUIRED: Indica el número de comprobante o el hash de la transacción';
  END IF;
  IF v_w.currency = 'USDT' THEN
    v_rate := COALESCE(p_usdt_rate, v_w.usdt_rate_estimate);
    IF v_rate IS NULL OR v_rate <= 0 THEN
      RAISE EXCEPTION 'INVALID_RATE: Indica la cotización usada';
    END IF;
    v_usdt := round(COALESCE(p_usdt_amount, v_w.amount / v_rate), 2);
    IF v_usdt <= 0 THEN
      RAISE EXCEPTION 'INVALID_AMOUNT: Indica los USDT enviados';
    END IF;
  END IF;

  SELECT balance INTO v_balance FROM public.accounts WHERE id = v_w.account_id FOR UPDATE;
  IF COALESCE(v_balance, 0) < v_w.amount THEN
    RAISE EXCEPTION 'INSUFFICIENT_BALANCE: La cuenta de comisiones no tiene saldo suficiente';
  END IF;

  SELECT id INTO v_type_id FROM public.transaction_types WHERE code = 'withdrawal';

  -- El saldo se actualiza antes del movimiento (igual que _charge_commission)
  UPDATE public.accounts SET balance = balance - v_w.amount, updated_at = now() WHERE id = v_w.account_id;

  INSERT INTO public.transactions (
    transaction_type_id, from_account_id, to_account_id, amount, currency, concept,
    payment_method, payment_reference, status, commission_amount, processed_by,
    external_cbu, external_alias, external_holder_name,
    processing_at, completed_at, metadata
  ) VALUES (
    v_type_id, v_w.account_id, NULL, v_w.amount, 'ARS',
    CASE WHEN v_w.currency = 'USDT' THEN 'Retiro de comisiones en USDT' ELSE 'Retiro de comisiones' END,
    CASE WHEN v_w.currency = 'USDT' THEN 'usdt' ELSE 'bank_transfer' END,
    left(trim(p_reference), 120), 'completed', 0, 'admin',
    CASE WHEN v_w.destination->>'destination' ~ '^\d{22}$' THEN v_w.destination->>'destination' END,
    CASE WHEN v_w.destination->>'destination' !~ '^\d{22}$' THEN v_w.destination->>'destination' END,
    NULLIF(v_w.destination->>'holder_name', ''),
    now(), now(),
    jsonb_build_object('withdrawal_id', v_w.id, 'currency', v_w.currency, 'destination', v_w.destination,
                       'usdt_rate', v_rate, 'usdt_amount', v_usdt)
  ) RETURNING id INTO v_tx_id;

  UPDATE public.distributor_withdrawals
     SET status = 'paid', payment_reference = left(trim(p_reference), 120),
         usdt_rate = v_rate, usdt_amount = v_usdt, transaction_id = v_tx_id,
         resolved_at = now(), resolved_by = auth.uid()
   WHERE id = p_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_resolve_withdrawal(uuid, text, text, text, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_withdrawal(uuid, text, text, text, numeric, numeric) TO authenticated;

-- =============================================================================
-- 6. Listado de retiros (admin: todos o de un distribuidor; distribuidor: los suyos)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.withdrawal_list(
  p_status text DEFAULT NULL,
  p_distributor_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid, distributor_id uuid, distributor_name text, amount numeric, currency text,
  destination jsonb, usdt_rate_estimate numeric, status text, created_at timestamptz,
  resolved_at timestamptz, reject_reason text, payment_reference text,
  usdt_rate numeric, usdt_amount numeric, available_balance numeric
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
  SELECT w.id, w.distributor_id, d.name, w.amount, w.currency, w.destination, w.usdt_rate_estimate,
         w.status, w.created_at, w.resolved_at, w.reject_reason, w.payment_reference,
         w.usdt_rate, w.usdt_amount,
         -- saldo de la cuenta de comisiones (para que el admin vea si alcanza)
         COALESCE((SELECT a.balance FROM public.accounts a WHERE a.id = w.account_id), 0)
    FROM public.distributor_withdrawals w
    JOIN public.distributors d ON d.id = w.distributor_id
   WHERE (v_dist IS NULL OR w.distributor_id = v_dist)
     AND (p_status IS NULL OR w.status = p_status)
   ORDER BY (w.status = 'pending') DESC, w.created_at DESC
   LIMIT least(greatest(COALESCE(p_limit, 500), 1), 5000);
END;
$$;
REVOKE ALL ON FUNCTION public.withdrawal_list(text, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdrawal_list(text, uuid, integer) TO authenticated;

-- =============================================================================
-- 7. Movimientos de los CVUs del distribuidor
-- =============================================================================
CREATE OR REPLACE FUNCTION public.distributor_movements(
  p_from timestamptz,
  p_to timestamptz,
  p_distributor_id uuid DEFAULT NULL,
  p_account_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 1000
)
RETURNS TABLE (
  id uuid, created_at timestamptz, account_id uuid, holder_name text, cvu text, alias text,
  direction text, type_code text, type_name text, amount numeric, commission numeric,
  status text, reference_number text, distributor_name text
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
    SELECT a.id, a.user_id, a.cvu, a.alias, a.distributor_id
      FROM public.accounts a
     WHERE a.purpose = 'customer'
       AND a.distributor_id IS NOT NULL
       AND (v_dist IS NULL OR a.distributor_id = v_dist)
       AND (p_account_id IS NULL OR a.id = p_account_id)
  )
  SELECT t.id, t.created_at, acc.id,
         public.user_holder_name(acc.user_id)::text, acc.cvu::text, acc.alias::text,
         CASE WHEN t.to_account_id = acc.id THEN 'in' ELSE 'out' END,
         tt.code::text, tt.name::text, t.amount,
         -- comisión que pagó este CVU por el movimiento
         COALESCE((SELECT sum(ce.fee_total) FROM public.commission_entries ce
                    WHERE ce.related_transaction_id = t.id AND ce.payer_account_id = acc.id), 0),
         t.status::text, t.reference_number::text, d.name
    FROM accs acc
    JOIN public.transactions t ON (t.to_account_id = acc.id OR t.from_account_id = acc.id)
    JOIN public.transaction_types tt ON tt.id = t.transaction_type_id
    JOIN public.distributors d ON d.id = acc.distributor_id
   WHERE tt.code <> 'commission'
     AND t.created_at >= p_from AND t.created_at < p_to
   ORDER BY t.created_at DESC
   LIMIT least(greatest(COALESCE(p_limit, 1000), 1), 5000);
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_movements(timestamptz, timestamptz, uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_movements(timestamptz, timestamptz, uuid, uuid, integer) TO authenticated;
