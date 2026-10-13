-- =============================================================================
-- Auditoría (2026-10-13): secreto del notification-worker en Vault
--
-- El x-worker-secret estaba escrito en enqueue_notification,
-- trigger_enqueue_transaction_notification y el cron job process-notification-queue
-- (y por eso también en los backups del repo). Ahora se lee de Vault.
--
-- Antes de aplicar: crear el secreto en Vault con el mismo valor que la variable
-- WORKER_SECRET de las edge functions:
--   select vault.create_secret('<valor>', 'worker_secret', 'Secreto del notification-worker');
-- (para rotarlo: vault.update_secret + supabase secrets set WORKER_SECRET=<valor>)
-- =============================================================================

CREATE OR REPLACE FUNCTION public._worker_headers()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'Content-Type', 'application/json',
    'x-worker-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'worker_secret')
  );
$$;
REVOKE ALL ON FUNCTION public._worker_headers() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._worker_headers() TO service_role;

-- Reemplaza el header escrito en el código por la lectura de Vault
DO $$
DECLARE
  v_pattern constant text := '''\{"Content-Type": "application/json", "x-worker-secret": "[^"]+"\}''::jsonb';
  v_fn text;
  v_def text;
  v_job record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'worker_secret') THEN
    RAISE EXCEPTION 'Falta el secreto worker_secret en Vault (ver el encabezado de esta migración)';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY['public.enqueue_notification(uuid, text, jsonb, uuid)',
                              'public.trigger_enqueue_transaction_notification()'] LOOP
    v_def := pg_get_functiondef(v_fn::regprocedure);
    IF v_def ~ v_pattern THEN
      EXECUTE regexp_replace(v_def, v_pattern, 'public._worker_headers()', 'g');
    END IF;
  END LOOP;

  FOR v_job IN SELECT jobid, command FROM cron.job WHERE command ~ v_pattern LOOP
    PERFORM cron.alter_job(v_job.jobid, command := regexp_replace(v_job.command, v_pattern, 'public._worker_headers()', 'g'));
  END LOOP;
END $$;
