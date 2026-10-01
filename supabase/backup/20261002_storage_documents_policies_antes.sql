-- Respaldo: bucket documents era public=true con estas políticas (2026-10-02)
CREATE POLICY "All flreew_3" ON storage.objects AS PERMISSIVE FOR INSERT TO public WITH CHECK ((bucket_id = 'documents'::text));
CREATE POLICY "All flreew_0" ON storage.objects AS PERMISSIVE FOR DELETE TO public USING ((bucket_id = 'documents'::text));
CREATE POLICY "All flreew_1" ON storage.objects AS PERMISSIVE FOR SELECT TO public USING ((bucket_id = 'documents'::text));
CREATE POLICY "All flreew_2" ON storage.objects AS PERMISSIVE FOR UPDATE TO public USING ((bucket_id = 'documents'::text));
