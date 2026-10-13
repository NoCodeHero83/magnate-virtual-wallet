-- =============================================================================
-- Auditoría (2026-10-13): 2FA (TOTP) para el panel de admin y distribuidores
--
-- El panel pide configurar y validar un código TOTP. Con el switch
-- app_settings.require_staff_mfa = true la base también lo exige: is_admin(),
-- is_distributor() y current_distributor_id() solo valen con una sesión aal2
-- (contraseña + código). Arranca en false para no cortar el panel publicado antes
-- de esta versión; se activa desde Configuración.
-- =============================================================================

INSERT INTO public.app_settings (key, value, updated_at)
VALUES ('require_staff_mfa', 'false'::jsonb, now())
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION public._staff_mfa_ok()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT NOT COALESCE((SELECT (value #>> '{}')::boolean FROM public.app_settings WHERE key = 'require_staff_mfa'), false)
      OR COALESCE(auth.jwt() ->> 'aal', '') = 'aal2';
$$;
REVOKE ALL ON FUNCTION public._staff_mfa_ok() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role = 'admin'
  ) AND public._staff_mfa_ok();
END;
$function$;

CREATE OR REPLACE FUNCTION public.is_distributor()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'distributor')
     AND public._staff_mfa_ok();
$$;

CREATE OR REPLACE FUNCTION public.current_distributor_id()
RETURNS uuid
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.id
    FROM public.distributors d
    JOIN public.users u ON u.id = d.user_id
   WHERE d.user_id = auth.uid() AND u.role = 'distributor'
     AND public._staff_mfa_ok();
$$;

-- El panel consulta si la base exige el 2FA (para el switch de Configuración)
CREATE OR REPLACE FUNCTION public.staff_mfa_required()
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT (value #>> '{}')::boolean FROM public.app_settings WHERE key = 'require_staff_mfa'), false);
$$;
REVOKE ALL ON FUNCTION public.staff_mfa_required() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_mfa_required() TO authenticated;
