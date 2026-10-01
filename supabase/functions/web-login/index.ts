import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"
import bcryptjs from "npm:bcryptjs@2.4.3"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, password } = await req.json()

    if (!email || !password) {
      return new Response(
        JSON.stringify({ error: 'Email y contraseña son requeridos' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      )
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    // 1. Fetch user data
    const { data: user, error: fetchError } = await supabaseAdmin
      .from('users')
      .select(`
        id, 
        email, 
        web_access_enabled, 
        web_password_hash, 
        first_name, 
        last_name,
        verification_status,
        user_auth_credentials (
          auto_password_encrypted
        )
      `)
      .eq('email', email.toLowerCase().trim())
      .single()

    if (fetchError || !user) {
      return new Response(
        JSON.stringify({ error: 'Usuario no encontrado o credenciales inválidas' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    // 2. Check web access
    if (!user.web_access_enabled) {
      return new Response(
        JSON.stringify({ error: 'Acceso web no habilitado. Por favor habilítalo desde la app móvil.' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      )
    }

    // 3. Verify password with bcryptjs (pure JS, no Workers needed)
    const passwordMatch = await bcryptjs.compare(password, user.web_password_hash)

    if (!passwordMatch) {
      return new Response(
        JSON.stringify({ error: 'Contraseña incorrecta' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      )
    }

    // 4. Check account status on the server (before, only the browser checked it,
    //    and the credentials were returned to suspended / pending / rejected users)
    const statusErrors: Record<string, string> = {
      suspended: 'Cuenta suspendida',
      rejected: 'Tu solicitud de cuenta fue rechazada. Contacta a soporte para más información.',
      pending: 'Tu cuenta está en revisión. Te avisaremos por email cuando sea aprobada.',
    }
    if (user.verification_status !== 'verified') {
      return new Response(
        JSON.stringify({ error: statusErrors[user.verification_status] ?? 'Cuenta pendiente de verificación' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 403 }
      )
    }

    // 5. Success
    const authCredentials = Array.isArray(user.user_auth_credentials)
      ? user.user_auth_credentials[0]
      : user.user_auth_credentials

    return new Response(
      JSON.stringify({
        success: true,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          verification_status: user.verification_status,
          auto_password_encrypted: authCredentials?.auto_password_encrypted ?? null
        }
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    )

  } catch (error) {
    console.error('Error in web-login:', error)
    return new Response(
      JSON.stringify({ error: error.message }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    )
  }
})