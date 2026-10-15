-- Monto mínimo de retiro con formato argentino ($ 1.000,00): lc_numeric de la base es en_US
CREATE OR REPLACE FUNCTION public.distributor_request_withdrawal(p_amount numeric, p_currency text, p_destination jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
