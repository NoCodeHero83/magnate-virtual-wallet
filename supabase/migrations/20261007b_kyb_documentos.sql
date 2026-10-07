-- =============================================================================
-- KYB: documentación de empresas (Persona Jurídica)
--
-- * La empresa sube sus documentos desde la app, ya con sesión iniciada
--   (no se aceptan subidas anónimas). Ruta en el bucket privado "documents":
--     kyb/{user_id}/{tipo}/{archivo}
-- * El admin revisa cada documento (aprobar / rechazar con motivo) desde el panel.
-- * Un documento rechazado se puede volver a subir: el anterior queda 'replaced'.
-- * Aprobar la cuenta no exige los documentos (lo decide el admin); el panel avisa
--   si faltan documentos obligatorios aprobados.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.business_document_types (
  code text PRIMARY KEY,
  name text NOT NULL,
  description text,
  required boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

INSERT INTO public.business_document_types (code, name, description, required, sort_order) VALUES
  ('estatuto', 'Estatuto o contrato social', 'Con la inscripción en el registro correspondiente (IGJ / DPPJ).', true, 1),
  ('constancia_cuit', 'Constancia de CUIT', 'Constancia de inscripción en ARCA (ex AFIP) de la empresa.', true, 2),
  ('poder_representante', 'Acta de designación o poder', 'Documento que acredita al representante legal que abrió la cuenta.', true, 3),
  ('dni_representante', 'DNI del representante', 'Frente y dorso. Opcional: la identidad ya se valida en el registro.', false, 4)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.business_document_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read document types" ON public.business_document_types;
CREATE POLICY "Authenticated read document types" ON public.business_document_types
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "Admins manage document types" ON public.business_document_types;
CREATE POLICY "Admins manage document types" ON public.business_document_types
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
REVOKE ALL ON public.business_document_types FROM anon;

CREATE TABLE IF NOT EXISTS public.business_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  doc_type text NOT NULL REFERENCES public.business_document_types(code),
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'replaced')),
  reason text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_business_documents_user ON public.business_documents(user_id, doc_type, created_at DESC);
-- Un solo documento vigente por tipo
CREATE UNIQUE INDEX IF NOT EXISTS business_documents_current_uq
  ON public.business_documents(user_id, doc_type) WHERE status <> 'replaced';

ALTER TABLE public.business_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owner reads own documents" ON public.business_documents;
CREATE POLICY "Owner reads own documents" ON public.business_documents
  FOR SELECT TO authenticated USING (user_id = auth.uid());
DROP POLICY IF EXISTS "Admins read documents" ON public.business_documents;
CREATE POLICY "Admins read documents" ON public.business_documents
  FOR SELECT TO authenticated USING (public.is_admin());
REVOKE ALL ON public.business_documents FROM anon;
-- Las escrituras van solo por las funciones de abajo
REVOKE INSERT, UPDATE, DELETE ON public.business_documents FROM authenticated;

-- Storage: la empresa sube a su carpeta kyb/{su id}/ (PDF o imagen) y puede leer lo suyo
DROP POLICY IF EXISTS "documents: owner uploads kyb" ON storage.objects;
CREATE POLICY "documents: owner uploads kyb" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = 'kyb'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND lower(storage.extension(name)) IN ('pdf', 'jpg', 'jpeg', 'png')
  );

DROP POLICY IF EXISTS "documents: owner reads kyb" ON storage.objects;
CREATE POLICY "documents: owner reads kyb" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND (storage.foldername(name))[1] = 'kyb'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

-- Registrar un documento ya subido al bucket
CREATE OR REPLACE FUNCTION public.submit_business_document(
  p_doc_type text,
  p_storage_path text,
  p_file_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_object storage.objects;
  v_current public.business_documents;
  v_size bigint;
  v_mime text;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'UNAUTHORIZED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_uid AND account_type = 'business' AND role = 'user') THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_BUSINESS');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.business_document_types WHERE code = p_doc_type AND is_active) THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_TYPE');
  END IF;
  IF p_storage_path NOT LIKE 'kyb/' || v_uid::text || '/' || p_doc_type || '/%' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_PATH');
  END IF;

  SELECT * INTO v_object FROM storage.objects WHERE bucket_id = 'documents' AND name = p_storage_path;
  IF v_object.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'FILE_NOT_FOUND');
  END IF;
  v_size := COALESCE((v_object.metadata->>'size')::bigint, 0);
  v_mime := COALESCE(v_object.metadata->>'mimetype', 'application/octet-stream');
  IF v_size > 10 * 1024 * 1024 THEN
    RETURN jsonb_build_object('success', false, 'error', 'FILE_TOO_LARGE');
  END IF;
  IF v_mime NOT IN ('application/pdf', 'image/jpeg', 'image/png') THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_FILE');
  END IF;

  SELECT * INTO v_current FROM public.business_documents
   WHERE user_id = v_uid AND doc_type = p_doc_type AND status <> 'replaced'
   FOR UPDATE;
  IF v_current.status = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ALREADY_APPROVED');
  END IF;
  IF v_current.id IS NOT NULL THEN
    UPDATE public.business_documents SET status = 'replaced' WHERE id = v_current.id;
  END IF;

  INSERT INTO public.business_documents (user_id, doc_type, storage_path, file_name, mime_type, size_bytes)
  VALUES (v_uid, p_doc_type, p_storage_path, left(COALESCE(NULLIF(trim(p_file_name), ''), 'documento'), 200), v_mime, v_size)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('success', true, 'id', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_business_document(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_business_document(text, text, text) TO authenticated;

-- Revisión de un documento por el admin
CREATE OR REPLACE FUNCTION public.admin_review_document(p_document_id uuid, p_decision text, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_doc public.business_documents;
  v_type_name text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'UNAUTHORIZED: Solo un administrador puede revisar documentos';
  END IF;
  IF p_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'INVALID_DECISION: Decisión inválida';
  END IF;
  IF p_decision = 'reject' AND (p_reason IS NULL OR length(trim(p_reason)) < 3) THEN
    RAISE EXCEPTION 'REASON_REQUIRED: Indica el motivo del rechazo';
  END IF;

  SELECT * INTO v_doc FROM public.business_documents WHERE id = p_document_id FOR UPDATE;
  IF v_doc.id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND: Documento no encontrado';
  END IF;
  IF v_doc.status = 'replaced' THEN
    RAISE EXCEPTION 'DOCUMENT_REPLACED: El usuario ya subió una versión nueva de este documento';
  END IF;

  UPDATE public.business_documents
     SET status = CASE WHEN p_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
         reason = CASE WHEN p_decision = 'reject' THEN trim(p_reason) ELSE NULL END,
         reviewed_by = auth.uid(),
         reviewed_at = now()
   WHERE id = p_document_id;

  IF p_decision = 'reject' THEN
    SELECT name INTO v_type_name FROM public.business_document_types WHERE code = v_doc.doc_type;
    PERFORM public.enqueue_notification(
      v_doc.user_id, 'business_document_rejected',
      jsonb_build_object('document_name', v_type_name, 'reason', trim(p_reason)),
      NULL
    );
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_review_document(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_review_document(uuid, text, text) TO authenticated;

INSERT INTO public.notification_types (code, name, description, priority, template_title, template_message, default_enabled, email_template_html)
VALUES
  ('business_document_rejected', 'Documento rechazado', 'Un documento de la empresa fue rechazado en la revisión', 1,
   '{"es": "Revisa la documentación de tu empresa", "en": "Please review your company documents"}',
   '{"es": "Rechazamos el documento \"{{document_name}}\". Súbelo de nuevo desde la app.", "en": "We rejected \"{{document_name}}\". Please upload it again from the app."}',
   true,
   jsonb_build_object('es', '<div style="font-family: sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; border-radius: 10px;"><h2 style="color: #1a1a1a;">{{title}}</h2><p>Hola {{first_name}},</p><p>{{message}}</p><div style="background: #f9f9f9; padding: 15px; border-radius: 8px; margin: 20px 0;"><p><strong>Motivo:</strong> {{reason}}</p></div><p>Entra a la app, ve a Perfil &gt; Documentación de la empresa y sube el documento corregido.</p><p style="color: #666; font-size: 12px;">Este es un correo automático, por favor no lo respondas.</p></div>'))
ON CONFLICT (code) DO NOTHING;
