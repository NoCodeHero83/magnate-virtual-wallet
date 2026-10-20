-- Volumen de los CVUs: configurable desde el panel (Configuración → Comisiones de distribuidores).
--
-- volume_amount_basis:
--   'received' (por defecto, como hasta ahora): el monto que recibió el destino. En una transferencia
--              con la comisión descontada, es el monto menos la comisión.
--   'sent':     el monto que mandó el cliente (metadata.requested_amount), con la comisión incluida
--              si se descontó del monto.
-- Aplica a los reportes de volumen (Mis CVUs, movimientos del distribuidor y volumen del día en el
-- dashboard). No cambia saldos ni comisiones.

INSERT INTO public.app_settings (key, value, description)
VALUES ('volume_amount_basis', '"received"',
        'Monto que cuenta como volumen: received (lo que recibió el destino) | sent (lo que mandó el cliente)')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._volume_amount(p_amount numeric, p_metadata jsonb)
 RETURNS numeric
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
           WHEN public._setting_text('volume_amount_basis', 'received') = 'sent'
                AND (p_metadata->>'requested_amount') ~ '^[0-9]+(\.[0-9]+)?$'
             THEN (p_metadata->>'requested_amount')::numeric
           ELSE p_amount
         END;
$function$;

CREATE OR REPLACE FUNCTION public.distributor_account_volume(p_from timestamp with time zone, p_to timestamp with time zone, p_distributor_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(account_id uuid, distributor_id uuid, distributor_name text, holder_name text, cvu text, alias text, account_status text, account_type text, volume_in numeric, volume_out numeric, operations bigint, fee_total numeric, distributor_amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
           sum(CASE WHEN t.to_account_id = acc.id THEN public._volume_amount(t.amount, t.metadata) ELSE 0 END) AS v_in,
           sum(CASE WHEN t.from_account_id = acc.id THEN public._volume_amount(t.amount, t.metadata) ELSE 0 END) AS v_out,
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
$function$;

CREATE OR REPLACE FUNCTION public.distributor_movements(p_from timestamp with time zone, p_to timestamp with time zone, p_distributor_id uuid DEFAULT NULL::uuid, p_account_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 1000)
 RETURNS TABLE(id uuid, created_at timestamp with time zone, account_id uuid, holder_name text, cvu text, alias text, direction text, type_code text, type_name text, amount numeric, commission numeric, status text, reference_number text, distributor_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
         tt.code::text, tt.name::text, public._volume_amount(t.amount, t.metadata),
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_dashboard_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_today_start timestamptz := date_trunc('day', now() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                               AT TIME ZONE 'America/Argentina/Buenos_Aires';
  v_custody numeric;
  v_volume numeric;
  v_count int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;

  SELECT COALESCE(sum(balance), 0) INTO v_custody
    FROM public.accounts
   WHERE purpose = 'customer';

  SELECT COALESCE(sum(public._volume_amount(t.amount, t.metadata)), 0), count(*) INTO v_volume, v_count
    FROM public.transactions t
    JOIN public.transaction_types tt ON tt.id = t.transaction_type_id
   WHERE t.status = 'completed'
     AND t.created_at >= v_today_start
     AND tt.code IN ('transfer_out', 'deposit', 'withdrawal');

  RETURN jsonb_build_object(
    'custody_balance', v_custody,
    'today_volume', v_volume,
    'today_count', v_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.commission_settings()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.is_admin() OR public.is_distributor()) THEN
    RAISE EXCEPTION 'FORBIDDEN';
  END IF;
  RETURN jsonb_build_object(
    'network_enabled', public.get_setting_bool('network_enabled', false),
    'network_level_percents', public._setting_json('network_level_percents', '[]'::jsonb),
    'settlement_period', public._setting_text('settlement_period', 'instant'),
    'inactive_distributor_share', public._setting_text('inactive_distributor_share', 'magnate'),
    'volume_amount_basis', public._setting_text('volume_amount_basis', 'received'),
    'usdt_networks', public._setting_json('usdt_networks', '["TRC20", "BEP20"]'::jsonb)
  );
END;
$function$;

DROP FUNCTION IF EXISTS public.admin_set_commission_settings(boolean, numeric[], text, text);
CREATE OR REPLACE FUNCTION public.admin_set_commission_settings(p_network_enabled boolean, p_network_level_percents numeric[], p_settlement_period text, p_inactive_distributor_share text, p_volume_amount_basis text DEFAULT 'received'::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  IF p_volume_amount_basis IS NULL OR p_volume_amount_basis NOT IN ('received', 'sent') THEN
    RAISE EXCEPTION 'INVALID_VOLUME_BASIS';
  END IF;
  INSERT INTO public.app_settings (key, value, updated_at, updated_by) VALUES
    ('network_enabled', to_jsonb(p_network_enabled), now(), auth.uid()),
    ('network_level_percents', to_jsonb((SELECT COALESCE(array_agg(trim_scale(round(x, 4)) ORDER BY o), '{}')
                                           FROM unnest(v_levels) WITH ORDINALITY u(x, o))), now(), auth.uid()),
    ('settlement_period', to_jsonb(p_settlement_period), now(), auth.uid()),
    ('inactive_distributor_share', to_jsonb(p_inactive_distributor_share), now(), auth.uid()),
    ('volume_amount_basis', to_jsonb(p_volume_amount_basis), now(), auth.uid())
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by;
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_set_commission_settings(boolean, numeric[], text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_commission_settings(boolean, numeric[], text, text, text) TO authenticated;
