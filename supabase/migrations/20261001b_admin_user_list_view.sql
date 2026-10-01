-- Vista para el panel admin: usuarios + datos de empresa (búsqueda y filtros en una sola consulta)
-- security_invoker: aplica las políticas RLS de quien consulta (solo admins ven todo)
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
  bp.incorporation_date AS company_incorporation_date
FROM public.users u
LEFT JOIN public.business_profiles bp ON bp.user_id = u.id
LEFT JOIN public.legal_entity_types let ON let.code = bp.legal_entity_type;

REVOKE ALL ON public.admin_user_list FROM anon;
GRANT SELECT ON public.admin_user_list TO authenticated;
