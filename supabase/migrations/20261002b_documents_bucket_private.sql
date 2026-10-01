-- =============================================================================
-- Bucket "documents" privado
-- Fecha: 2026-10-02
-- Respaldo de las políticas previas: supabase/backup/20261002_storage_documents_policies_antes.sql
--
-- Antes: bucket público + políticas que permitían a cualquiera (incluso sin
-- sesión) leer, sobrescribir y borrar cualquier archivo (contratos firmados).
-- Ahora:
--   - Registro (anon/autenticado): solo puede SUBIR PDFs nuevos en contracts/presignup/
--   - Lectura / gestión: solo administradores (URLs firmadas desde el panel)
-- Los valores guardados en users.zapsign_contract_url no se modifican; el panel
-- admin resuelve tanto URLs públicas viejas como rutas nuevas.
-- =============================================================================

BEGIN;

UPDATE storage.buckets SET public = false WHERE id = 'documents';

DROP POLICY IF EXISTS "All flreew_0" ON storage.objects;
DROP POLICY IF EXISTS "All flreew_1" ON storage.objects;
DROP POLICY IF EXISTS "All flreew_2" ON storage.objects;
DROP POLICY IF EXISTS "All flreew_3" ON storage.objects;

-- Subida del contrato firmado durante el registro (el usuario aún no tiene sesión)
DROP POLICY IF EXISTS "documents: upload signup contracts" ON storage.objects;
CREATE POLICY "documents: upload signup contracts" ON storage.objects
  FOR INSERT TO anon, authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = 'contracts'
    AND (storage.foldername(name))[2] = 'presignup'
    AND lower(storage.extension(name)) = 'pdf'
  );

-- Administradores: lectura (URLs firmadas) y gestión
DROP POLICY IF EXISTS "documents: admins read" ON storage.objects;
CREATE POLICY "documents: admins read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND public.is_admin());

DROP POLICY IF EXISTS "documents: admins update" ON storage.objects;
CREATE POLICY "documents: admins update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'documents' AND public.is_admin())
  WITH CHECK (bucket_id = 'documents' AND public.is_admin());

DROP POLICY IF EXISTS "documents: admins delete" ON storage.objects;
CREATE POLICY "documents: admins delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'documents' AND public.is_admin());

-- El panel admin necesita el contrato en la vista de usuarios
CREATE OR REPLACE VIEW public.admin_user_list
WITH (security_invoker = true) AS
SELECT
  u.id, u.first_name, u.last_name, u.email, u.phone, u.dni, u.cuit_cuil,
  u.role, u.verification_status, u.account_type, u.status_reason,
  u.reviewed_by, u.reviewed_at, u.photo_url, u.created_at, u.updated_at,
  bp.cuit               AS company_cuit,
  bp.legal_name         AS company_legal_name,
  bp.trade_name         AS company_trade_name,
  bp.legal_entity_type  AS company_entity_type,
  let.name              AS company_entity_type_name,
  bp.incorporation_date AS company_incorporation_date,
  u.zapsign_contract_url
FROM public.users u
LEFT JOIN public.business_profiles bp ON bp.user_id = u.id
LEFT JOIN public.legal_entity_types let ON let.code = bp.legal_entity_type;

COMMIT;
