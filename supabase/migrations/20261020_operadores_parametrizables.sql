-- =============================================================================
-- Operadores (distribuidores) parametrizables — 2026-10-20
--
-- Todo se configura desde el panel; con los valores iniciales nada cambia respecto
-- de cómo se cobra hoy.
--
-- * Reparto por operador: distributors.share_percent (% de la comisión para el
--   operador). Orden: regla del CVU o del operador con reparto propio → % del
--   operador → regla por defecto. En las reglas que no son por defecto,
--   magnate_share_percent NULL = "usar el reparto del operador".
-- * Reglas de comisión por operador (fee_rules.distributor_id): valen para todos
--   sus CVUs. Orden para la tarifa: regla del CVU → regla del operador → por defecto.
-- * Red: distributors.parent_distributor_id (quién lo trajo). Con la red activada,
--   cada nivel hacia arriba cobra un % de la comisión (network_level_percents),
--   que sale de la parte de Magnate. Cada operador puede no cobrar de su red
--   (distributors.network_enabled = false).
-- * Liquidación: instant | weekly | biweekly | monthly (general y por operador). Lo
--   ganado en el período en curso no se puede retirar hasta que el período cierra.
--   Los períodos se cortan en hora argentina.
-- * Ajustes manuales del saldo de un operador, con motivo obligatorio.
-- * Redes de USDT habilitadas para los retiros (por defecto TRC20 y BEP20).
-- * Operador inactivo: su parte va a Magnate (como hasta ahora) o se le sigue
--   acreditando (inactive_distributor_share).
-- =============================================================================

-- =============================================================================
-- 1. Configuración general
-- =============================================================================
INSERT INTO public.app_settings (key, value, description) VALUES
  ('network_enabled', 'false'::jsonb,
   'Los operadores cobran un % de las comisiones de los operadores que trajeron'),
  ('network_level_percents', '[]'::jsonb,
   '% de la comisión que cobra cada nivel hacia arriba: [nivel 1, nivel 2, ...]'),
  ('settlement_period', '"instant"'::jsonb,
   'Liquidación de los operadores: instant | weekly | biweekly | monthly'),
  ('inactive_distributor_share', '"magnate"'::jsonb,
   'Parte de un operador inactivo: magnate (se la queda Magnate) | distributor (se le sigue acreditando)'),
  ('usdt_networks', '["TRC20", "BEP20"]'::jsonb,
   'Redes de USDT habilitadas para los retiros de los operadores')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._setting_text(p_key text, p_default text)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT value #>> '{}' FROM public.app_settings WHERE key = p_key), p_default);
$$;
REVOKE ALL ON FUNCTION public._setting_text(text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._setting_json(p_key text, p_default jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT value FROM public.app_settings WHERE key = p_key), p_default);
$$;
REVOKE ALL ON FUNCTION public._setting_json(text, jsonb) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 2. Operadores: quién lo trajo, reparto, red y liquidación propios
-- =============================================================================
ALTER TABLE public.distributors
  ADD COLUMN IF NOT EXISTS parent_distributor_id uuid REFERENCES public.distributors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS share_percent numeric(5,2),
  ADD COLUMN IF NOT EXISTS network_enabled boolean,
  ADD COLUMN IF NOT EXISTS settlement_period text;

ALTER TABLE public.distributors DROP CONSTRAINT IF EXISTS distributors_share_percent_check;
ALTER TABLE public.distributors ADD CONSTRAINT distributors_share_percent_check
  CHECK (share_percent IS NULL OR (share_percent >= 0 AND share_percent <= 100));
ALTER TABLE public.distributors DROP CONSTRAINT IF EXISTS distributors_settlement_period_check;
ALTER TABLE public.distributors ADD CONSTRAINT distributors_settlement_period_check
  CHECK (settlement_period IS NULL OR settlement_period IN ('instant', 'weekly', 'biweekly', 'monthly'));
ALTER TABLE public.distributors DROP CONSTRAINT IF EXISTS distributors_not_own_parent;
ALTER TABLE public.distributors ADD CONSTRAINT distributors_not_own_parent
  CHECK (parent_distributor_id IS DISTINCT FROM id);
CREATE INDEX IF NOT EXISTS idx_distributors_parent ON public.distributors(parent_distributor_id)
  WHERE parent_distributor_id IS NOT NULL;

-- Un operador no puede quedar debajo de sí mismo (A trajo a B y B trajo a A)
CREATE OR REPLACE FUNCTION public.distributors_check_parent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid := NEW.parent_distributor_id;
  v_steps int := 0;
BEGIN
  WHILE v_id IS NOT NULL LOOP
    IF v_id = NEW.id THEN
      RAISE EXCEPTION 'PARENT_CYCLE: Ese operador ya está en la red de este operador';
    END IF;
    v_steps := v_steps + 1;
    IF v_steps > 100 THEN
      RAISE EXCEPTION 'PARENT_CYCLE: La red tiene demasiados niveles';
    END IF;
    SELECT parent_distributor_id INTO v_id FROM public.distributors WHERE id = v_id;
  END LOOP;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS distributors_check_parent ON public.distributors;
CREATE TRIGGER distributors_check_parent
  BEFORE INSERT OR UPDATE OF parent_distributor_id ON public.distributors
  FOR EACH ROW EXECUTE FUNCTION public.distributors_check_parent();

-- =============================================================================
-- 3. Reglas de comisión por operador y reparto heredado
-- =============================================================================
ALTER TABLE public.fee_rules
  ADD COLUMN IF NOT EXISTS distributor_id uuid REFERENCES public.distributors(id) ON DELETE CASCADE;

ALTER TABLE public.fee_rules DROP CONSTRAINT IF EXISTS fee_rules_one_scope;
ALTER TABLE public.fee_rules ADD CONSTRAINT fee_rules_one_scope
  CHECK (account_id IS NULL OR distributor_id IS NULL);

DROP INDEX IF EXISTS public.fee_rules_default_uq;
CREATE UNIQUE INDEX fee_rules_default_uq ON public.fee_rules(operation)
  WHERE account_id IS NULL AND distributor_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fee_rules_distributor_uq ON public.fee_rules(distributor_id, operation)
  WHERE distributor_id IS NOT NULL;

-- NULL = la regla no fija el reparto: se usa el del operador (o el de la regla por defecto)
ALTER TABLE public.fee_rules ALTER COLUMN magnate_share_percent DROP NOT NULL;
ALTER TABLE public.fee_rules ALTER COLUMN magnate_share_percent DROP DEFAULT;
ALTER TABLE public.fee_rules DROP CONSTRAINT IF EXISTS fee_rules_default_share;
ALTER TABLE public.fee_rules ADD CONSTRAINT fee_rules_default_share
  CHECK (account_id IS NOT NULL OR distributor_id IS NOT NULL OR magnate_share_percent IS NOT NULL);

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
  IF NEW.distributor_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.distributors WHERE id = NEW.distributor_id
  ) THEN
    RAISE EXCEPTION 'INVALID_DISTRIBUTOR: El operador no existe';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.fee_rules_keep_defaults()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.account_id IS NULL AND OLD.distributor_id IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: Las reglas por defecto no se pueden borrar';
  END IF;
  RETURN OLD;
END;
$$;

-- Regla aplicable: la del CVU; si no, la de su operador; si no, la por defecto
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
     AND (r.account_id = p_account_id
          OR r.distributor_id = (SELECT a.distributor_id FROM public.accounts a WHERE a.id = p_account_id)
          OR (r.account_id IS NULL AND r.distributor_id IS NULL))
   ORDER BY CASE WHEN r.account_id IS NOT NULL THEN 0
                 WHEN r.distributor_id IS NOT NULL THEN 1
                 ELSE 2 END
   LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._fee_rule(uuid, text) FROM PUBLIC, anon, authenticated;

-- % de la comisión para el operador del CVU
CREATE OR REPLACE FUNCTION public._distributor_share_percent(
  p_rule public.fee_rules,
  p_distributor_share numeric,
  p_operation text
)
RETURNS numeric
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF (p_rule.account_id IS NOT NULL OR p_rule.distributor_id IS NOT NULL)
     AND p_rule.magnate_share_percent IS NOT NULL THEN
    RETURN 100 - p_rule.magnate_share_percent;
  END IF;
  IF p_distributor_share IS NOT NULL THEN
    RETURN p_distributor_share;
  END IF;
  RETURN 100 - COALESCE((
    SELECT r.magnate_share_percent FROM public.fee_rules r
     WHERE r.operation = p_operation AND r.account_id IS NULL AND r.distributor_id IS NULL
  ), 100);
END;
$$;
REVOKE ALL ON FUNCTION public._distributor_share_percent(public.fee_rules, numeric, text) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 4. Registro de comisiones: parte de la red
-- =============================================================================
ALTER TABLE public.commission_entries
  ADD COLUMN IF NOT EXISTS network_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rule_scope text,
  ADD COLUMN IF NOT EXISTS distributor_share_percent numeric(5,2);

-- El control de la suma pasa a incluir la parte de la red
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.commission_entries'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%distributor_amount%fee_total%'
  LOOP
    EXECUTE format('ALTER TABLE public.commission_entries DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;
ALTER TABLE public.commission_entries ADD CONSTRAINT commission_entries_split_check
  CHECK (magnate_amount + distributor_amount + network_amount = fee_total);

CREATE TABLE IF NOT EXISTS public.commission_network_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_entry_id uuid NOT NULL REFERENCES public.commission_entries(id) ON DELETE CASCADE,
  distributor_id uuid REFERENCES public.distributors(id) ON DELETE SET NULL,
  source_distributor_id uuid REFERENCES public.distributors(id) ON DELETE SET NULL,
  level integer NOT NULL CHECK (level >= 1),
  rate_percent numeric(7,4) NOT NULL,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  transaction_id uuid REFERENCES public.transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commission_network_distributor
  ON public.commission_network_entries(distributor_id, created_at DESC);

ALTER TABLE public.commission_network_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commission_network_entries FROM anon;
DROP POLICY IF EXISTS "Admins read network commissions" ON public.commission_network_entries;
CREATE POLICY "Admins read network commissions" ON public.commission_network_entries
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Distributor reads own network commissions" ON public.commission_network_entries;
CREATE POLICY "Distributor reads own network commissions" ON public.commission_network_entries
  FOR SELECT TO authenticated USING (distributor_id IS NOT NULL AND distributor_id = public.current_distributor_id());

-- Cobra una comisión ya calculada: movimiento del cliente a la cuenta de Magnate y,
-- después, reparto al operador del CVU y a los niveles de su red.
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
  v_inactive_policy text := public._setting_text('inactive_distributor_share', 'magnate');
  v_credit_distributor boolean := false;
  v_share numeric;
  v_dist_amount numeric := 0;
  v_magnate_left numeric;
  v_tx_id uuid;
  v_entry_id uuid;
  v_levels jsonb;
  v_level integer := 0;
  v_anc_id uuid;
  v_anc public.distributors;
  v_pct numeric;
  v_amount numeric;
  v_net_total numeric := 0;
  v_net_tx uuid;
  v_net jsonb := '[]'::jsonb;
  v_row jsonb;
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

  -- Operador inactivo: según la configuración, su parte va a Magnate o se le sigue acreditando
  v_credit_distributor := v_distributor.id IS NOT NULL AND v_distributor.commission_account_id IS NOT NULL
                          AND (v_distributor.status = 'active' OR v_inactive_policy = 'distributor');
  IF v_credit_distributor THEN
    v_share := public._distributor_share_percent(p_rule, v_distributor.share_percent, p_operation);
    v_dist_amount := round(p_fee * v_share / 100, 2);
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
  v_magnate_left := p_fee - v_dist_amount;

  -- Red: cada nivel hacia arriba cobra su % de la comisión, de la parte de Magnate
  IF v_distributor.id IS NOT NULL AND public.get_setting_bool('network_enabled', false) THEN
    v_levels := public._setting_json('network_level_percents', '[]'::jsonb);
    IF jsonb_typeof(v_levels) = 'array' THEN
      v_anc_id := v_distributor.parent_distributor_id;
      WHILE v_anc_id IS NOT NULL AND v_level < jsonb_array_length(v_levels) AND v_magnate_left > 0 LOOP
        v_level := v_level + 1;
        SELECT * INTO v_anc FROM public.distributors WHERE id = v_anc_id;
        EXIT WHEN v_anc.id IS NULL;
        v_pct := COALESCE((v_levels->>(v_level - 1))::numeric, 0);
        IF v_pct > 0
           AND COALESCE(v_anc.network_enabled, true)
           AND v_anc.commission_account_id IS NOT NULL
           AND (v_anc.status = 'active' OR v_inactive_policy = 'distributor') THEN
          v_amount := least(round(p_fee * v_pct / 100, 2), v_magnate_left);
          IF v_amount > 0 THEN
            UPDATE public.accounts SET balance = balance - v_amount, updated_at = now() WHERE id = v_magnate_acc;
            UPDATE public.accounts SET balance = balance + v_amount, updated_at = now()
             WHERE id = v_anc.commission_account_id;
            INSERT INTO public.transactions (
              transaction_type_id, from_account_id, to_account_id, amount, currency, concept,
              payment_method, status, commission_amount, processed_by, reference_number,
              processing_at, completed_at, metadata
            ) VALUES (
              v_type_id, v_magnate_acc, v_anc.commission_account_id, v_amount, 'ARS',
              'Comisión de red (nivel ' || v_level || ')',
              'commission', 'completed', 0, 'system', p_reference || '-FEE-R' || v_level,
              now(), now(),
              jsonb_build_object('operation', p_operation, 'related_transaction_id', p_related_transaction_id,
                                 'commission_transaction_id', v_tx_id, 'network', true, 'level', v_level,
                                 'source_distributor_id', v_distributor.id)
            ) RETURNING id INTO v_net_tx;
            v_net := v_net || jsonb_build_object('distributor_id', v_anc.id, 'level', v_level,
                                                 'rate', v_pct, 'amount', v_amount, 'tx', v_net_tx);
            v_magnate_left := v_magnate_left - v_amount;
            v_net_total := v_net_total + v_amount;
          END IF;
        END IF;
        v_anc_id := v_anc.parent_distributor_id;
      END LOOP;
    END IF;
  END IF;

  INSERT INTO public.commission_entries (
    transaction_id, related_transaction_id, payer_account_id, distributor_id, operation,
    base_amount, rate_percent, fixed_amount, charge_mode, fee_total, magnate_amount, distributor_amount,
    network_amount, rule_scope, distributor_share_percent
  ) VALUES (
    v_tx_id, p_related_transaction_id, p_payer_account_id,
    CASE WHEN v_credit_distributor THEN v_distributor.id END,
    p_operation, p_base_amount, p_rule.rate_percent, p_rule.fixed_amount, p_rule.charge_mode,
    p_fee, v_magnate_left, v_dist_amount, v_net_total,
    CASE WHEN p_rule.account_id IS NOT NULL THEN 'account'
         WHEN p_rule.distributor_id IS NOT NULL THEN 'distributor'
         ELSE 'default' END,
    v_share
  ) RETURNING id INTO v_entry_id;

  FOR v_row IN SELECT * FROM jsonb_array_elements(v_net) LOOP
    INSERT INTO public.commission_network_entries (
      commission_entry_id, distributor_id, source_distributor_id, level, rate_percent, amount, transaction_id
    ) VALUES (
      v_entry_id, (v_row->>'distributor_id')::uuid, v_distributor.id, (v_row->>'level')::int,
      (v_row->>'rate')::numeric, (v_row->>'amount')::numeric, (v_row->>'tx')::uuid
    );
  END LOOP;

  RETURN v_tx_id;
END;
$$;
REVOKE ALL ON FUNCTION public._charge_commission(uuid, text, numeric, public.fee_rules, numeric, uuid, text) FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 5. Liquidación: período en curso y disponible para retirar
-- =============================================================================
CREATE OR REPLACE FUNCTION public._distributor_settlement_period(p_distributor_id uuid)
RETURNS text
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(
    (SELECT d.settlement_period FROM public.distributors d WHERE d.id = p_distributor_id),
    public._setting_text('settlement_period', 'instant'));
$$;
REVOKE ALL ON FUNCTION public._distributor_settlement_period(uuid) FROM PUBLIC, anon, authenticated;

-- Período que contiene p_at, en hora argentina. instant = sin período (empieza y termina en p_at).
CREATE OR REPLACE FUNCTION public._settlement_bounds(p_period text, p_at timestamptz DEFAULT now())
RETURNS TABLE (period_start timestamptz, period_end timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_tz constant text := 'America/Argentina/Buenos_Aires';
  v_local timestamp := p_at AT TIME ZONE v_tz;
  v_month timestamp := date_trunc('month', v_local);
  v_s timestamp;
  v_e timestamp;
BEGIN
  IF p_period = 'weekly' THEN
    v_s := date_trunc('week', v_local);
    v_e := v_s + interval '7 days';
  ELSIF p_period = 'biweekly' THEN
    IF extract(day FROM v_local) >= 16 THEN
      v_s := v_month + interval '15 days';
      v_e := v_month + interval '1 month';
    ELSE
      v_s := v_month;
      v_e := v_month + interval '15 days';
    END IF;
  ELSIF p_period = 'monthly' THEN
    v_s := v_month;
    v_e := v_month + interval '1 month';
  ELSE
    RETURN QUERY SELECT p_at, p_at;
    RETURN;
  END IF;
  RETURN QUERY SELECT v_s AT TIME ZONE v_tz, v_e AT TIME ZONE v_tz;
END;
$$;
REVOKE ALL ON FUNCTION public._settlement_bounds(text, timestamptz) FROM PUBLIC, anon, authenticated;

-- Saldo, lo ganado en el período en curso (todavía no se retira), reservado y disponible.
-- Los ajustes manuales quedan disponibles en el momento.
CREATE OR REPLACE FUNCTION public._distributor_funds(p_distributor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_acc uuid;
  v_balance numeric;
  v_reserved numeric;
  v_period text := public._distributor_settlement_period(p_distributor_id);
  v_start timestamptz;
  v_end timestamptz;
  v_in_progress numeric := 0;
BEGIN
  SELECT d.commission_account_id, COALESCE(a.balance, 0) INTO v_acc, v_balance
    FROM public.distributors d
    LEFT JOIN public.accounts a ON a.id = d.commission_account_id
   WHERE d.id = p_distributor_id;
  v_balance := COALESCE(v_balance, 0);

  SELECT COALESCE(sum(amount), 0) INTO v_reserved
    FROM public.distributor_withdrawals
   WHERE distributor_id = p_distributor_id AND status = 'pending';

  SELECT b.period_start, b.period_end INTO v_start, v_end FROM public._settlement_bounds(v_period) b;
  IF v_period <> 'instant' AND v_acc IS NOT NULL THEN
    SELECT COALESCE(sum(t.amount), 0) INTO v_in_progress
      FROM public.transactions t
     WHERE t.to_account_id = v_acc
       AND t.status = 'completed'
       AND t.created_at >= v_start
       AND NOT (COALESCE(t.metadata, '{}'::jsonb) ? 'adjustment_id');
  END IF;

  RETURN jsonb_build_object(
    'balance', v_balance,
    'reserved', v_reserved,
    'in_progress', v_in_progress,
    'available', greatest(v_balance - v_reserved - v_in_progress, 0),
    'settlement_period', v_period,
    'period_start', CASE WHEN v_period <> 'instant' THEN v_start END,
    'release_at', CASE WHEN v_period <> 'instant' THEN v_end END
  );
END;
$$;
REVOKE ALL ON FUNCTION public._distributor_funds(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.distributor_balance(p_distributor_id uuid DEFAULT NULL)
RETURNS jsonb
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
  IF v_dist IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  RETURN public._distributor_funds(v_dist) || jsonb_build_object(
    'paid_total', (SELECT COALESCE(sum(amount), 0) FROM public.distributor_withdrawals
                    WHERE distributor_id = v_dist AND status = 'paid')
  );
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_balance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_balance(uuid) TO authenticated;

-- Lo ganado por período (los últimos p_count). Con liquidación instantánea se agrupa por mes.
CREATE OR REPLACE FUNCTION public.distributor_period_summary(
  p_distributor_id uuid DEFAULT NULL,
  p_count integer DEFAULT 6
)
RETURNS TABLE (
  period_start timestamptz, period_end timestamptz, is_open boolean,
  commissions numeric, network numeric, adjustments numeric, withdrawals numeric
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_dist uuid;
  v_acc uuid;
  v_period text;
  v_at timestamptz := now();
  v_s timestamptz;
  v_e timestamptz;
  i integer;
BEGIN
  IF NOT (public.is_admin() OR public.is_distributor()) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  v_dist := public._resolve_distributor(p_distributor_id);
  IF v_dist IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  SELECT commission_account_id INTO v_acc FROM public.distributors WHERE id = v_dist;
  v_period := public._distributor_settlement_period(v_dist);
  IF v_period = 'instant' THEN
    v_period := 'monthly';
  END IF;

  FOR i IN 1..least(greatest(COALESCE(p_count, 6), 1), 24) LOOP
    SELECT b.period_start, b.period_end INTO v_s, v_e FROM public._settlement_bounds(v_period, v_at) b;
    RETURN QUERY
    SELECT v_s, v_e, v_e > now(),
           COALESCE(sum(t.amount) FILTER (WHERE t.to_account_id = v_acc AND NOT (m ? 'adjustment_id') AND NOT (m ? 'network')), 0),
           COALESCE(sum(t.amount) FILTER (WHERE t.to_account_id = v_acc AND (m ? 'network')), 0),
           COALESCE(sum(CASE WHEN t.to_account_id = v_acc THEN t.amount ELSE -t.amount END)
                      FILTER (WHERE m ? 'adjustment_id'), 0),
           COALESCE(sum(t.amount) FILTER (WHERE t.from_account_id = v_acc AND (m ? 'withdrawal_id')), 0)
      FROM public.transactions t
      CROSS JOIN LATERAL (SELECT COALESCE(t.metadata, '{}'::jsonb) AS m) x
     WHERE v_acc IS NOT NULL
       AND (t.to_account_id = v_acc OR t.from_account_id = v_acc)
       AND t.status = 'completed'
       AND t.created_at >= v_s AND t.created_at < v_e;
    v_at := v_s - interval '1 second';
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_period_summary(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_period_summary(uuid, integer) TO authenticated;

-- =============================================================================
-- 6. Retiros: disponible según la liquidación y redes de USDT configurables
-- =============================================================================
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
    'usdt_rate', public._setting_numeric('usdt_ars_rate'),
    'usdt_networks', public._setting_json('usdt_networks', '["TRC20", "BEP20"]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.withdrawal_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.withdrawal_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.distributor_request_withdrawal(p_amount numeric, p_currency text, p_destination jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_d public.distributors;
  v_funds jsonb;
  v_min numeric := public._setting_numeric('withdrawal_min_amount');
  v_rate numeric := public._setting_numeric('usdt_ars_rate');
  v_networks jsonb := public._setting_json('usdt_networks', '["TRC20", "BEP20"]'::jsonb);
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
    RAISE EXCEPTION 'AMOUNT_BELOW_MINIMUM: El monto mínimo de retiro es $ %', replace(replace(replace(to_char(v_min, 'FM999,999,999,990.00'), ',', '#'), '.', ','), '#', '.');
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
    IF jsonb_typeof(v_networks) <> 'array' OR NOT (v_networks ? COALESCE(p_destination->>'network', '')) THEN
      RAISE EXCEPTION 'INVALID_NETWORK: Elige una de las redes habilitadas';
    END IF;
    v_dest := jsonb_build_object('wallet', v_target, 'network', p_destination->>'network');
  ELSE
    RAISE EXCEPTION 'INVALID_CURRENCY: La moneda debe ser ARS o USDT';
  END IF;

  -- Bloquea la cuenta de comisiones: dos pedidos a la vez no pueden reservar el mismo saldo
  PERFORM 1 FROM public.accounts WHERE id = v_d.commission_account_id FOR UPDATE;
  v_funds := public._distributor_funds(v_d.id);
  IF p_amount > (v_funds->>'available')::numeric THEN
    IF (v_funds->>'in_progress')::numeric > 0 THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: El monto supera tu saldo disponible. Lo ganado en el período en curso se libera al cerrar el período';
    END IF;
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

-- =============================================================================
-- 7. Ajustes manuales del saldo de un operador
--    A favor: sale de la cuenta de comisiones de Magnate. En contra: vuelve a Magnate.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.distributor_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  distributor_id uuid NOT NULL REFERENCES public.distributors(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK (amount <> 0),
  reason text NOT NULL CHECK (length(trim(reason)) >= 5),
  transaction_id uuid REFERENCES public.transactions(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_distributor_adjustments_distributor
  ON public.distributor_adjustments(distributor_id, created_at DESC);

ALTER TABLE public.distributor_adjustments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.distributor_adjustments FROM anon;
DROP POLICY IF EXISTS "Admins read adjustments" ON public.distributor_adjustments;
CREATE POLICY "Admins read adjustments" ON public.distributor_adjustments
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS "Distributor reads own adjustments" ON public.distributor_adjustments;
CREATE POLICY "Distributor reads own adjustments" ON public.distributor_adjustments
  FOR SELECT TO authenticated USING (distributor_id = public.current_distributor_id());

CREATE OR REPLACE FUNCTION public.admin_adjust_distributor(p_distributor_id uuid, p_amount numeric, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_d public.distributors;
  v_magnate_acc uuid := public._magnate_commission_account_id();
  v_amount numeric := round(p_amount, 2);
  v_reason text := trim(COALESCE(p_reason, ''));
  v_from uuid;
  v_to uuid;
  v_abs numeric;
  v_balance numeric;
  v_reserved numeric;
  v_type_id uuid;
  v_id uuid := gen_random_uuid();
  v_tx_id uuid;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF v_amount IS NULL OR v_amount = 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT: El monto del ajuste no puede ser 0';
  END IF;
  IF length(v_reason) < 5 THEN
    RAISE EXCEPTION 'REASON_REQUIRED: Indica el motivo del ajuste (mínimo 5 caracteres)';
  END IF;
  SELECT * INTO v_d FROM public.distributors WHERE id = p_distributor_id;
  IF v_d.id IS NULL OR v_d.commission_account_id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: Operador no encontrado';
  END IF;
  IF v_magnate_acc IS NULL THEN
    RAISE EXCEPTION 'COMMISSION_ACCOUNT_MISSING: No está configurada la cuenta de comisiones';
  END IF;

  v_abs := abs(v_amount);
  IF v_amount > 0 THEN
    v_from := v_magnate_acc;
    v_to := v_d.commission_account_id;
  ELSE
    v_from := v_d.commission_account_id;
    v_to := v_magnate_acc;
  END IF;

  -- Bloqueo en orden fijo para no cruzarse con otra operación
  PERFORM 1 FROM public.accounts WHERE id IN (v_from, v_to) ORDER BY id FOR UPDATE;
  SELECT balance INTO v_balance FROM public.accounts WHERE id = v_from;
  IF v_amount > 0 THEN
    IF COALESCE(v_balance, 0) < v_abs THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: La cuenta de comisiones de Magnate no tiene saldo para este ajuste';
    END IF;
  ELSE
    SELECT COALESCE(sum(amount), 0) INTO v_reserved
      FROM public.distributor_withdrawals WHERE distributor_id = v_d.id AND status = 'pending';
    IF COALESCE(v_balance, 0) - v_reserved < v_abs THEN
      RAISE EXCEPTION 'INSUFFICIENT_BALANCE: El operador no tiene saldo libre para este ajuste (saldo % y retiros pendientes %)',
        COALESCE(v_balance, 0), v_reserved;
    END IF;
  END IF;

  SELECT id INTO v_type_id FROM public.transaction_types WHERE code = 'commission';

  -- El saldo se actualiza antes del movimiento (igual que _charge_commission)
  UPDATE public.accounts SET balance = balance - v_abs, updated_at = now() WHERE id = v_from;
  UPDATE public.accounts SET balance = balance + v_abs, updated_at = now() WHERE id = v_to;

  INSERT INTO public.transactions (
    transaction_type_id, from_account_id, to_account_id, amount, currency, concept,
    payment_method, status, commission_amount, processed_by, reference_number,
    processing_at, completed_at, metadata
  ) VALUES (
    v_type_id, v_from, v_to, v_abs, 'ARS',
    CASE WHEN v_amount > 0 THEN 'Ajuste a favor' ELSE 'Ajuste en contra' END,
    'commission', 'completed', 0, 'admin',
    'ADJ-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(v_id::text, 1, 8)),
    now(), now(),
    jsonb_build_object('adjustment_id', v_id, 'distributor_id', v_d.id, 'amount', v_amount, 'reason', v_reason)
  ) RETURNING id INTO v_tx_id;

  INSERT INTO public.distributor_adjustments (id, distributor_id, amount, reason, transaction_id, created_by)
  VALUES (v_id, v_d.id, v_amount, v_reason, v_tx_id, auth.uid());
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_adjust_distributor(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_adjust_distributor(uuid, numeric, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.distributor_adjustment_list(p_distributor_id uuid DEFAULT NULL, p_limit integer DEFAULT 200)
RETURNS TABLE (id uuid, created_at timestamptz, distributor_id uuid, distributor_name text, amount numeric, reason text)
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
  SELECT a.id, a.created_at, a.distributor_id, d.name, a.amount, a.reason
    FROM public.distributor_adjustments a
    JOIN public.distributors d ON d.id = a.distributor_id
   WHERE v_dist IS NULL OR a.distributor_id = v_dist
   ORDER BY a.created_at DESC
   LIMIT least(greatest(COALESCE(p_limit, 200), 1), 2000);
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_adjustment_list(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_adjustment_list(uuid, integer) TO authenticated;

-- =============================================================================
-- 8. Configuración (panel)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.commission_settings()
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
    'network_enabled', public.get_setting_bool('network_enabled', false),
    'network_level_percents', public._setting_json('network_level_percents', '[]'::jsonb),
    'settlement_period', public._setting_text('settlement_period', 'instant'),
    'inactive_distributor_share', public._setting_text('inactive_distributor_share', 'magnate'),
    'usdt_networks', public._setting_json('usdt_networks', '["TRC20", "BEP20"]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.commission_settings() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commission_settings() TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_commission_settings(
  p_network_enabled boolean,
  p_network_level_percents numeric[],
  p_settlement_period text,
  p_inactive_distributor_share text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_levels numeric[] := COALESCE(p_network_level_percents, '{}');
  v_pct numeric;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_network_enabled IS NULL THEN
    RAISE EXCEPTION 'INVALID_NETWORK_ENABLED';
  END IF;
  IF array_length(v_levels, 1) > 10 THEN
    RAISE EXCEPTION 'INVALID_LEVELS: Como máximo 10 niveles de red';
  END IF;
  FOREACH v_pct IN ARRAY v_levels LOOP
    IF v_pct IS NULL OR v_pct < 0 OR v_pct > 100 THEN
      RAISE EXCEPTION 'INVALID_LEVELS: Cada nivel debe estar entre 0 y 100 %%';
    END IF;
  END LOOP;
  IF (SELECT COALESCE(sum(x), 0) FROM unnest(v_levels) x) > 100 THEN
    RAISE EXCEPTION 'INVALID_LEVELS: La suma de los niveles no puede superar el 100 %% de la comisión';
  END IF;
  IF p_settlement_period IS NULL OR p_settlement_period NOT IN ('instant', 'weekly', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'INVALID_PERIOD: Período de liquidación inválido';
  END IF;
  IF p_inactive_distributor_share IS NULL OR p_inactive_distributor_share NOT IN ('magnate', 'distributor') THEN
    RAISE EXCEPTION 'INVALID_INACTIVE_POLICY';
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at, updated_by) VALUES
    ('network_enabled', to_jsonb(p_network_enabled), now(), auth.uid()),
    ('network_level_percents', to_jsonb((SELECT COALESCE(array_agg(trim_scale(round(x, 4)) ORDER BY o), '{}')
                                           FROM unnest(v_levels) WITH ORDINALITY u(x, o))), now(), auth.uid()),
    ('settlement_period', to_jsonb(p_settlement_period), now(), auth.uid()),
    ('inactive_distributor_share', to_jsonb(p_inactive_distributor_share), now(), auth.uid())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_commission_settings(boolean, numeric[], text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_commission_settings(boolean, numeric[], text, text) TO authenticated;

-- Redes de USDT habilitadas para los retiros (se editan junto con la configuración de retiros)
CREATE OR REPLACE FUNCTION public.admin_set_usdt_networks(p_networks text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_networks text[];
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  SELECT array_agg(DISTINCT upper(trim(n)) ORDER BY upper(trim(n))) INTO v_networks
    FROM unnest(COALESCE(p_networks, '{}')) n;
  IF v_networks IS NULL OR NOT (v_networks <@ ARRAY['TRC20', 'BEP20', 'ERC20', 'POLYGON']) THEN
    RAISE EXCEPTION 'INVALID_NETWORKS: Elige al menos una red de USDT válida';
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at, updated_by)
  VALUES ('usdt_networks', to_jsonb(v_networks), now(), auth.uid())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_usdt_networks(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_usdt_networks(text[]) TO authenticated;

-- Configuración de comisiones de un operador (NULL = usa la general)
CREATE OR REPLACE FUNCTION public.admin_set_distributor_commission(
  p_id uuid,
  p_parent_id uuid,
  p_share_percent numeric,
  p_network_enabled boolean,
  p_settlement_period text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  IF p_share_percent IS NOT NULL AND (p_share_percent < 0 OR p_share_percent > 100) THEN
    RAISE EXCEPTION 'INVALID_SHARE: El %% del operador debe estar entre 0 y 100';
  END IF;
  IF p_settlement_period IS NOT NULL AND p_settlement_period NOT IN ('instant', 'weekly', 'biweekly', 'monthly') THEN
    RAISE EXCEPTION 'INVALID_PERIOD: Período de liquidación inválido';
  END IF;
  IF p_parent_id IS NOT NULL AND p_parent_id = p_id THEN
    RAISE EXCEPTION 'PARENT_CYCLE: Un operador no puede haberse traído a sí mismo';
  END IF;
  IF p_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.distributors WHERE id = p_parent_id) THEN
    RAISE EXCEPTION 'NOT_FOUND: El operador que lo trajo no existe';
  END IF;

  UPDATE public.distributors
     SET parent_distributor_id = p_parent_id,
         share_percent = round(p_share_percent, 2),
         network_enabled = p_network_enabled,
         settlement_period = p_settlement_period,
         updated_at = now()
   WHERE id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'NOT_FOUND: Operador no encontrado';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_distributor_commission(uuid, uuid, numeric, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_distributor_commission(uuid, uuid, numeric, boolean, text) TO authenticated;

-- Lista de operadores con su configuración y saldos (admin)
DROP FUNCTION IF EXISTS public.admin_distributor_list();
CREATE FUNCTION public.admin_distributor_list()
RETURNS TABLE (
  id uuid, name text, cuit text, contact_email text, status text, created_at timestamptz,
  user_id uuid, login_email text, accounts_count bigint, commission_balance numeric,
  parent_id uuid, parent_name text, share_percent numeric, network_enabled boolean,
  settlement_period text, network_count bigint, available_balance numeric
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
         COALESCE(ca.balance, 0),
         d.parent_distributor_id, p.name, d.share_percent, d.network_enabled, d.settlement_period,
         (SELECT count(*) FROM public.distributors c WHERE c.parent_distributor_id = d.id),
         (public._distributor_funds(d.id)->>'available')::numeric
    FROM public.distributors d
    LEFT JOIN public.users u ON u.id = d.user_id
    LEFT JOIN public.accounts ca ON ca.id = d.commission_account_id
    LEFT JOIN public.distributors p ON p.id = d.parent_distributor_id
   ORDER BY d.name;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_distributor_list() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_distributor_list() TO authenticated;

-- =============================================================================
-- 9. Red del operador y lo que cobra de ella
-- =============================================================================
CREATE OR REPLACE FUNCTION public.distributor_network(p_distributor_id uuid DEFAULT NULL)
RETURNS TABLE (id uuid, name text, status text, level integer, parent_name text, accounts_count bigint)
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
  IF v_dist IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN QUERY
  WITH RECURSIVE tree AS (
    SELECT d.id, 1 AS lvl, ARRAY[d.id] AS path
      FROM public.distributors d WHERE d.parent_distributor_id = v_dist
    UNION ALL
    SELECT c.id, t.lvl + 1, t.path || c.id
      FROM public.distributors c JOIN tree t ON c.parent_distributor_id = t.id
     WHERE NOT c.id = ANY(t.path) AND t.lvl < 20
  )
  SELECT d.id, d.name, d.status, t.lvl, p.name,
         (SELECT count(*) FROM public.accounts a WHERE a.distributor_id = d.id)
    FROM tree t
    JOIN public.distributors d ON d.id = t.id
    LEFT JOIN public.distributors p ON p.id = d.parent_distributor_id
   ORDER BY t.lvl, d.name;
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_network(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_network(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.distributor_network_detail(
  p_from timestamptz,
  p_to timestamptz,
  p_distributor_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 500
)
RETURNS TABLE (
  id uuid, created_at timestamptz, distributor_name text, source_name text, level integer,
  operation text, fee_total numeric, rate_percent numeric, amount numeric
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
  SELECT n.id, n.created_at, d.name, s.name, n.level, ce.operation, ce.fee_total, n.rate_percent, n.amount
    FROM public.commission_network_entries n
    JOIN public.commission_entries ce ON ce.id = n.commission_entry_id
    LEFT JOIN public.distributors d ON d.id = n.distributor_id
    LEFT JOIN public.distributors s ON s.id = n.source_distributor_id
   WHERE n.created_at >= p_from AND n.created_at < p_to
     AND (v_dist IS NULL OR n.distributor_id = v_dist)
   ORDER BY n.created_at DESC
   LIMIT least(greatest(COALESCE(p_limit, 500), 1), 5000);
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_network_detail(timestamptz, timestamptz, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_network_detail(timestamptz, timestamptz, uuid, integer) TO authenticated;

-- Resumen de comisiones del período (admin): suma la parte de la red
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
      'network_total', COALESCE(sum(network_amount), 0),
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

-- Datos del operador que entra al panel
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
    'commission_balance', (SELECT balance FROM public.accounts WHERE id = v_d.commission_account_id),
    'parent_name', (SELECT p.name FROM public.distributors p WHERE p.id = v_d.parent_distributor_id),
    'network_count', (SELECT count(*) FROM public.distributors c WHERE c.parent_distributor_id = v_d.id),
    'settlement_period', public._distributor_settlement_period(v_d.id)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.distributor_me() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.distributor_me() TO authenticated;
