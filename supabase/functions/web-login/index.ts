// supabase/functions/web-login/index.ts
// Login de la web de usuarios: email + contraseña web.
//
// La contraseña se valida en la BD (web_login_check: límite de intentos y un único
// mensaje de error). Si es correcta, la sesión se crea aquí con un magic link de un
// solo uso que nunca sale del servidor. Antes se devolvía al navegador la contraseña
// de Supabase Auth (apenas ofuscada), que servía para entrar desde cualquier lado.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: object, status: number) =>
  new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status })

const ERRORS: Record<string, { message: string; status: number }> = {
  INVALID_CREDENTIALS: { message: 'Email o contraseña incorrectos', status: 401 },
  ACCOUNT_SUSPENDED: { message: 'Cuenta suspendida', status: 403 },
  ACCOUNT_REJECTED: { message: 'Tu solicitud de cuenta fue rechazada. Contacta a soporte para más información.', status: 403 },
  ACCOUNT_PENDING: { message: 'Tu cuenta está en revisión. Te avisaremos por email cuando sea aprobada.', status: 403 },
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { email, password } = await req.json().catch(() => ({}))
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return json({ error: 'Email y contraseña son requeridos' }, 400)
    }

    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAdmin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // 1. Contraseña web, estado de la cuenta e intentos (en la BD)
    const { data: check, error: checkError } = await supabaseAdmin.rpc('web_login_check', {
      p_email: email,
      p_password: password,
    })
    if (checkError || !check) {
      console.error('web_login_check error:', checkError?.message)
      return json({ error: 'No se pudo iniciar sesión. Intenta nuevamente.' }, 500)
    }
    if (!check.success) {
      if (check.error === 'LOCKED') {
        const minutes = Math.max(1, Math.ceil((check.retry_after_seconds ?? 900) / 60))
        return json({ error: `Demasiados intentos fallidos. Intenta nuevamente en ${minutes} minutos.` }, 429)
      }
      const known = ERRORS[check.error] ?? { message: 'Cuenta pendiente de verificación', status: 403 }
      return json({ error: known.message }, known.status)
    }

    // 2. Sesión creada en el servidor: magic link de un solo uso, canjeado aquí mismo
    const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email: check.email,
    })
    const tokenHash = link?.properties?.hashed_token
    if (linkError || !tokenHash) {
      console.error('generateLink error:', linkError?.message)
      return json({ error: 'No se pudo iniciar sesión. Intenta nuevamente.' }, 500)
    }

    const supabaseAnon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: verified, error: verifyError } = await supabaseAnon.auth.verifyOtp({
      token_hash: tokenHash,
      type: 'magiclink',
    })
    if (verifyError || !verified?.session) {
      console.error('verifyOtp error:', verifyError?.message)
      return json({ error: 'No se pudo iniciar sesión. Intenta nuevamente.' }, 500)
    }

    return json({
      success: true,
      session: {
        access_token: verified.session.access_token,
        refresh_token: verified.session.refresh_token,
      },
    }, 200)
  } catch (error) {
    console.error('Error in web-login:', error)
    return json({ error: 'No se pudo iniciar sesión. Intenta nuevamente.' }, 500)
  }
})
