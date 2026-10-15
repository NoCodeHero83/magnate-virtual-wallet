-- Números del dashboard del panel: saldo total en cuentas de clientes (lo que
-- tiene que haber en la cuenta recaudadora) y operaciones del día en hora argentina.
-- Cada operación cuenta una vez: se excluyen la pata de entrada de las
-- transferencias internas (transfer_in) y los movimientos de comisión.
CREATE OR REPLACE FUNCTION public.admin_dashboard_stats()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT COALESCE(sum(t.amount), 0), count(*) INTO v_volume, v_count
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
$$;

REVOKE ALL ON FUNCTION public.admin_dashboard_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_stats() TO authenticated;
