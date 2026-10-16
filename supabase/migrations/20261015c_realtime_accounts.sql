-- La app escucha los cambios de su propia cuenta (saldo al recibir dinero).
-- Realtime respeta RLS: cada usuario solo recibe los cambios de las cuentas que puede leer.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'accounts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.accounts;
  END IF;
END $$;
