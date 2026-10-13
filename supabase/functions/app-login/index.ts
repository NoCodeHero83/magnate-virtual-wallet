// supabase/functions/app-login/index.ts
// Login de la app: PIN + dispositivo de confianza (o código por email si es nuevo).
//
// login_with_pin / verify_device_login validan todo en la BD. Si el login es correcto,
// la sesión se crea aquí con un magic link de un solo uso que nunca sale del servidor.
// Antes la app recibía la contraseña de Supabase Auth (cifrada con una clave que
// viaja dentro de la app) y con ella podía entrarse desde cualquier lado.
//
// Body:
//   { action: "pin", email, pin, device }
//   { action: "verify_device", email, code, device }
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status })

const url = Deno.env.get('SUPABASE_URL') ?? ''
const noSession = { auth: { persistSession: false, autoRefreshToken: false } }
const supabaseAdmin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', noSession)

async function createSession(email: string) {
  const { data: link, error: linkError } = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email })
  const tokenHash = link?.properties?.hashed_token
  if (linkError || !tokenHash) throw new Error(`generateLink: ${linkError?.message}`)

  const supabaseAnon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', noSession)
  const { data, error } = await supabaseAnon.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' })
  if (error || !data?.session) throw new Error(`verifyOtp: ${error?.message}`)
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'METHOD_NOT_ALLOWED' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const { action, email, pin, code, device } = body ?? {}
    if (typeof email !== 'string' || !email || typeof device !== 'object' || device === null) {
      return json({ success: false, error: 'INVALID_REQUEST' }, 400)
    }

    let result: any
    if (action === 'pin') {
      if (typeof pin !== 'string') return json({ success: false, error: 'INVALID_REQUEST' }, 400)
      const { data, error } = await supabaseAdmin.rpc('login_with_pin', { p_email: email, p_pin: pin, p_device: device })
      if (error) throw new Error(`login_with_pin: ${error.message}`)
      result = data
    } else if (action === 'verify_device') {
      if (typeof code !== 'string') return json({ success: false, error: 'INVALID_REQUEST' }, 400)
      const { data, error } = await supabaseAdmin.rpc('verify_device_login', { p_email: email, p_device: device, p_code: code })
      if (error) throw new Error(`verify_device_login: ${error.message}`)
      result = data
    } else {
      return json({ success: false, error: 'INVALID_REQUEST' }, 400)
    }

    // La credencial interna nunca sale del servidor
    const { auto_password_encrypted: _secret, ...publicResult } = result ?? {}
    if (!publicResult.success) return json(publicResult)

    const { data: profile } = await supabaseAdmin.from('users').select('email').eq('id', publicResult.user_id).single()
    const session = await createSession(profile?.email ?? email)
    return json({ ...publicResult, session })
  } catch (error) {
    console.error('Error in app-login:', (error as Error).message)
    return json({ success: false, error: 'SERVER_ERROR' }, 500)
  }
})
