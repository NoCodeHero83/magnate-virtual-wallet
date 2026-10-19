// supabase/functions/zapsign/index.ts
// Verificación de identidad del registro con ZapSign, desde el servidor.
//
// El entorno se elige en app_settings (sin tocar la app) y las credenciales están en Supabase Vault:
//   app_environment = 'development' -> ZapSign sandbox  (zapsign_api_key_sandbox, zapsign_template_id_sandbox)
//   app_environment = 'production'  -> ZapSign real     (zapsign_api_key_prod, zapsign_template_id_prod,
//                                                         zapsign_selfie_validation_type_prod opcional)
//   identity_verification_mode = 'simulated' (solo development) -> no se llama a ZapSign y se da por verificada.
// Las lee public.zapsign_runtime_config(), que solo puede ejecutar el service role.
//
// Cada verificación queda en identity_verifications; el registro (handle_new_user) la exige en producción.
//
// Body:
//   { action: "create", name, email }  -> { success, docToken, signUrl } | { success, docToken, simulated: true }
//   { action: "status", docToken }     -> { success, status, signedFileUrl, signUrl }
//   { action: "verify", docToken }     -> { signed, verified, strict, signedFileUrl, biometric, error? }
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status })

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false, autoRefreshToken: false } },
)

// Documentos que se pueden crear por email por hora (cada uno consume créditos de ZapSign)
const MAX_CREATES_PER_HOUR = 5
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type Environment = 'development' | 'production'

interface ZapSignEnv {
  environment: Environment
  simulated: boolean
  baseUrl: string
  apiKey: string
  templateId: string
  selfieValidationType: string
}

async function loadEnv(): Promise<ZapSignEnv> {
  const { data, error } = await supabaseAdmin.rpc('zapsign_runtime_config')
  if (error) throw new Error(`zapsign_runtime_config: ${error.message}`)
  const environment: Environment = data?.environment === 'production' ? 'production' : 'development'
  return {
    environment,
    simulated: data?.simulated === true,
    baseUrl: environment === 'production' ? 'https://api.zapsign.com.br' : 'https://sandbox.api.zapsign.com.br',
    apiKey: (data?.api_key ?? '').trim(),
    templateId: (data?.template_id ?? '').trim(),
    selfieValidationType: (data?.selfie_validation_type ?? '').trim(),
  }
}

async function zapsign(env: ZapSignEnv, path: string, init: RequestInit = {}) {
  const res = await fetch(`${env.baseUrl}${path}`, {
    ...init,
    headers: { 'Authorization': `Bearer ${env.apiKey}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { /* texto plano */ }
  return { ok: res.ok, status: res.status, body, text }
}

const signUrlOf = (doc: any) => {
  const signer = doc?.signers?.[0]
  return signer?.sign_url || (signer?.token ? `https://app.zapsign.com.br/verificar/${signer.token}` : null)
}

/** Fila de la verificación; solo se consultan documentos creados por esta función */
async function findVerification(docToken: unknown) {
  if (typeof docToken !== 'string' || !docToken) return null
  const { data } = await supabaseAdmin.from('identity_verifications').select('*').eq('doc_token', docToken).maybeSingle()
  return data
}

async function handleCreate(env: ZapSignEnv, name: string, email: string) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { count } = await supabaseAdmin
    .from('identity_verifications')
    .select('id', { count: 'exact', head: true })
    .eq('email', email)
    .gte('created_at', since)
  if ((count ?? 0) >= MAX_CREATES_PER_HOUR) {
    return json({ success: false, error: 'Demasiados intentos. Prueba de nuevo en una hora.' }, 429)
  }

  if (env.simulated) {
    const docToken = `SIM-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const { error } = await supabaseAdmin.from('identity_verifications').insert({
      doc_token: docToken, email, environment: env.environment, simulated: true,
      status: 'verified', verified_at: now, biometric: { simulated: true, valid: true },
    })
    if (error) throw new Error(`insert simulated: ${error.message}`)
    return json({ success: true, docToken, simulated: true })
  }

  if (!env.apiKey || !env.templateId) {
    console.error(`[zapsign] Faltan las credenciales de ${env.environment}`)
    return json({ success: false, error: 'La verificación de identidad no está configurada. Contacta a soporte.' }, 503)
  }

  const prod = env.environment === 'production'
  const payload = {
    template_id: env.templateId,
    signer_name: name,
    send_automatic_email: false,
    signers: [{
      name,
      email,
      auth_mode: 'assinaturaTela',
      send_automatic_email: true,
      // Documento siempre; selfie solo en producción
      require_selfie_photo: prod,
      require_document_photo: true,
      ...(env.selfieValidationType ? { selfie_validation_type: env.selfieValidationType } : {}),
    }],
    data: [{ de: '{{Nombre}}', para: name }, { de: '{{Email}}', para: email }],
  }

  const res = await zapsign(env, '/api/v1/models/create-doc/', { method: 'POST', body: JSON.stringify(payload) })
  if (!res.ok || !res.body?.token) {
    console.error(`[zapsign] create-doc HTTP ${res.status}: ${res.text.slice(0, 500)}`)
    return json({ success: false, error: res.body?.detail || res.body?.error || `Error ${res.status} al crear el documento` }, 502)
  }

  const { error } = await supabaseAdmin.from('identity_verifications').insert({
    doc_token: res.body.token, email, environment: env.environment, simulated: false, status: 'pending',
  })
  if (error) throw new Error(`insert: ${error.message}`)

  return json({ success: true, docToken: res.body.token, signUrl: signUrlOf(res.body) })
}

async function handleStatus(env: ZapSignEnv, row: any) {
  if (row.simulated) return json({ success: true, status: 'signed', signedFileUrl: null, signUrl: null })
  const res = await zapsign(env, `/api/v1/docs/${row.doc_token}/`)
  if (!res.ok) return json({ success: false, error: res.status === 404 ? 'not found' : `HTTP ${res.status}` })
  return json({ success: true, status: res.body?.status, signedFileUrl: res.body?.signed_file ?? null, signUrl: signUrlOf(res.body) })
}

async function handleVerify(env: ZapSignEnv, row: any) {
  if (row.simulated) {
    return json({ signed: true, verified: true, strict: false, signedFileUrl: null, biometric: row.biometric })
  }

  const strict = env.environment === 'production' && !!env.selfieValidationType
  const doc = await zapsign(env, `/api/v1/docs/${row.doc_token}/`)
  if (!doc.ok) return json({ signed: false, verified: false, strict, error: doc.text || `HTTP ${doc.status}` })

  const signedFileUrl = doc.body?.signed_file ?? null
  const signed = doc.body?.status === 'assinado' || doc.body?.status === 'signed' || !!signedFileUrl
  if (!signed) return json({ signed: false, verified: false, strict, error: 'Documento aún no firmado' })

  const signerToken = doc.body?.signers?.[0]?.token ?? ''
  const val = await zapsign(env, `/api/v1/signer-verification-details/${signerToken}/`)
  const validations: any[] = val.ok ? (val.body?.validations ?? []) : []
  const ocr = validations.find((v) => v.document_ocr)?.document_ocr
  const biometric: Record<string, unknown> = {
    selfieValidationType: val.ok ? (val.body?.selfie_validation_type ?? null) : null,
    valid: false,
    validations,
    extractedName: ocr ? `${ocr.name || ''} ${ocr.last_name || ''}`.trim() : undefined,
    documentNumber: ocr?.document_number,
  }

  let verified: boolean
  if (!val.ok) {
    biometric.reason = strict ? 'no_validation_data' : 'validation_unavailable'
    verified = !strict
  } else {
    const allPassed = validations.length > 0 && validations.every((v) => v.status === null || v.status === 'success')
    biometric.valid = allPassed
    if (strict && !allPassed) biometric.reason = 'biometric_failed'
    // Sin modo estricto (sandbox) alcanza con el contrato firmado
    verified = strict ? allPassed : true
  }

  await supabaseAdmin.from('identity_verifications').update({
    status: verified ? 'verified' : 'failed',
    verified_at: verified ? new Date().toISOString() : null,
    signed_file_url: signedFileUrl,
    biometric,
    updated_at: new Date().toISOString(),
  }).eq('id', row.id).is('used_by', null)

  return json({ signed: true, verified, strict, signedFileUrl, biometric })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ success: false, error: 'METHOD_NOT_ALLOWED' }, 405)

  try {
    const body = await req.json().catch(() => ({}))
    const env = await loadEnv()

    if (body?.action === 'create') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
      if (!name || name.length > 200 || !EMAIL_RE.test(email)) {
        return json({ success: false, error: 'Completa tu nombre y email primero' }, 400)
      }
      return await handleCreate(env, name, email)
    }

    if (body?.action === 'status' || body?.action === 'verify') {
      const row = await findVerification(body.docToken)
      if (!row) return json({ success: false, signed: false, verified: false, error: 'not found' }, 404)
      // Un documento de otro entorno no sirve (se cambió el entorno a mitad del registro)
      if (row.environment !== env.environment) {
        return json({ success: false, signed: false, verified: false, error: 'not found' }, 404)
      }
      return body.action === 'status' ? await handleStatus(env, row) : await handleVerify(env, row)
    }

    return json({ success: false, error: 'INVALID_ACTION' }, 400)
  } catch (e) {
    console.error('[zapsign]', e)
    return json({ success: false, error: 'Error interno' }, 500)
  }
})
