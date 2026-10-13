-- =============================================================================
-- Auditoría (2026-10-13): las transferencias desde la app exigen el PIN
--
-- transfer_from_device solo validaba el dispositivo de confianza: con el teléfono
-- desbloqueado (o un link que abría la confirmación con destino y monto) bastaba un
-- toque. Ahora también valida el PIN con _check_pin (mismo bloqueo por intentos que
-- el login). Los errores de PIN se devuelven (no se lanzan) para que el intento
-- fallido quede registrado: una excepción desharía el contador.
-- La versión sin PIN se elimina: las apps viejas deben actualizarse.
-- =============================================================================

DROP FUNCTION IF EXISTS public.transfer_from_device(uuid, character varying, numeric, character varying, character varying, jsonb);

CREATE OR REPLACE FUNCTION public.transfer_from_device(
  p_from_account_id uuid,
  p_to_identifier character varying,
  p_amount numeric,
  p_concept character varying,
  p_payment_method character varying,
  p_device jsonb,
  p_pin text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_device_id uuid := public._trusted_device_id(auth.uid(), p_device);
  v_pin jsonb;
BEGIN
  IF v_device_id IS NULL THEN
    RAISE EXCEPTION 'DEVICE_NOT_TRUSTED: Este dispositivo no está verificado. Vuelve a iniciar sesión.';
  END IF;

  v_pin := public._check_pin(auth.uid(), p_pin);
  IF NOT (v_pin->>'success')::boolean THEN
    RETURN v_pin;   -- INVALID_PIN (attempts_left) / PIN_LOCKED (retry_after_seconds)
  END IF;

  RETURN public.process_transfer(p_from_account_id, p_to_identifier, p_amount, COALESCE(p_concept, ''),
                                 COALESCE(p_payment_method, 'alias'), v_device_id, NULL);
END;
$function$;

REVOKE ALL ON FUNCTION public.transfer_from_device(uuid, character varying, numeric, character varying, character varying, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transfer_from_device(uuid, character varying, numeric, character varying, character varying, jsonb, text) TO authenticated;
