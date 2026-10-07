// Crea (o renueva) el acceso al panel de un distribuidor.
// Solo lo puede llamar un administrador (se valida con su JWT).
//
// POST { action: "create", distributor_id, email, first_name, last_name }
//   -> { password }   contraseña temporal: se muestra una sola vez al admin
// POST { action: "reset_password", distributor_id }
//   -> { password }
//
// Antes de crear el usuario se registra el email en staff_invites (solo el service_role
// puede escribir esa tabla). handle_new_user ve la invitación y lo registra con
// role 'distributor' y sin cuenta bancaria. Nadie puede darse este rol desde la app.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

// Contraseña temporal: 14 caracteres sin ambiguos (0/O, 1/l/I)
function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  const admin = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    { auth: { persistSession: false } },
  )

  // 1. Quien llama debe ser administrador
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!token) return json({ error: 'No autorizado' }, 401)
  const { data: caller, error: callerError } = await admin.auth.getUser(token)
  if (callerError || !caller?.user) return json({ error: 'Sesión inválida' }, 401)
  const { data: callerRow } = await admin.from('users').select('role').eq('id', caller.user.id).maybeSingle()
  if (callerRow?.role !== 'admin') return json({ error: 'Solo un administrador puede hacer esto' }, 403)

  let body: any
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Solicitud inválida' }, 400)
  }

  const { action, distributor_id } = body ?? {}
  if (!distributor_id) return json({ error: 'Falta el distribuidor' }, 400)

  const { data: distributor } = await admin
    .from('distributors')
    .select('id, name, user_id, status')
    .eq('id', distributor_id)
    .maybeSingle()
  if (!distributor) return json({ error: 'Distribuidor no encontrado' }, 404)

  if (action === 'create') {
    if (distributor.user_id) return json({ error: 'El distribuidor ya tiene un acceso. Usa "Nueva contraseña".' }, 409)

    const email = String(body.email ?? '').trim().toLowerCase()
    const firstName = String(body.first_name ?? '').trim()
    const lastName = String(body.last_name ?? '').trim()
    if (!EMAIL_RE.test(email)) return json({ error: 'Email inválido' }, 400)
    if (!firstName) return json({ error: 'Falta el nombre de la persona que va a entrar' }, 400)

    const { data: existing } = await admin.from('users').select('id').eq('email', email).maybeSingle()
    if (existing) return json({ error: 'Ese email ya tiene una cuenta en Magnate. Usa otro email.' }, 409)

    const { error: inviteError } = await admin
      .from('staff_invites')
      .upsert({ email, role: 'distributor', distributor_id: distributor.id, created_at: new Date().toISOString(), consumed_at: null })
    if (inviteError) {
      console.error('staff_invites', inviteError)
      return json({ error: 'No se pudo preparar el acceso' }, 500)
    }

    const password = generatePassword()
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { first_name: firstName, last_name: lastName },
    })
    if (createError || !created?.user) {
      console.error('createUser', createError)
      await admin.from('staff_invites').delete().eq('email', email)
      return json({ error: 'No se pudo crear el acceso: ' + (createError?.message ?? 'error desconocido') }, 400)
    }

    // Verificar que el trigger lo haya registrado como distribuidor antes de vincularlo
    const { data: row } = await admin.from('users').select('role').eq('id', created.user.id).maybeSingle()
    if (row?.role !== 'distributor') {
      await admin.auth.admin.deleteUser(created.user.id)
      return json({ error: 'No se pudo registrar el acceso del distribuidor' }, 500)
    }

    const { error: linkError } = await admin
      .from('distributors')
      .update({ user_id: created.user.id, contact_email: email, updated_at: new Date().toISOString() })
      .eq('id', distributor.id)
      .is('user_id', null)
    if (linkError) {
      await admin.auth.admin.deleteUser(created.user.id)
      return json({ error: 'No se pudo vincular el acceso al distribuidor' }, 500)
    }

    return json({ success: true, email, password })
  }

  if (action === 'reset_password') {
    if (!distributor.user_id) return json({ error: 'El distribuidor todavía no tiene acceso' }, 409)
    const password = generatePassword()
    const { error } = await admin.auth.admin.updateUserById(distributor.user_id, { password })
    if (error) return json({ error: 'No se pudo cambiar la contraseña' }, 400)
    return json({ success: true, password })
  }

  return json({ error: 'Acción no válida' }, 400)
})
