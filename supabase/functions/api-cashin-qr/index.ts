// ============================================================
// POST /functions/v1/api-cashin-qr
// Genera un código QR dinámico para recibir un pago
//
// Headers: Authorization: Bearer <token>
// Body: {
//   "amount":      number,
//   "concept":     string,
//   "description": string (opcional)
// }
// Returns: { "status": "ok", "qr_code": string, "qr_order_id": string, "expires_at": string }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sin valor por defecto: si falta el secreto, ningún token es válido
const JWT_SECRET = Deno.env.get("API_JWT_SECRET") ?? "";

// ─── Utilidades JWT ───────────────────────────────────────────────────────────

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  return new Uint8Array(bin.split("").map((c) => c.charCodeAt(0)));
}

async function verifyJWT(token: string): Promise<Record<string, any>> {
  if (!JWT_SECRET) throw new Error("API_JWT_SECRET no configurado");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token malformado");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC", key, base64urlDecode(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error("Firma inválida");
  const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Token expirado");
  return payload;
}

// ─── Helpers de respuesta ─────────────────────────────────────────────────────

const CORS = { "Access-Control-Allow-Origin": "*" };

function ok(data: object): Response {
  return new Response(JSON.stringify({ status: "ok", ...data }), {
    status: 200, headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ status: "error", message }), {
    status, headers: { "Content-Type": "application/json", ...CORS },
  });
}

function getClientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip") ?? "unknown";
}

async function generateHash(data: string): Promise<string> {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(data));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { ...CORS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" },
    });
  }

  if (req.method !== "POST") return err(405, "Método no permitido");

  const start = Date.now();

  // 1. Verificar token
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return err(401, "Token requerido");

  let payload: Record<string, any>;
  try { payload = await verifyJWT(authHeader.slice(7)); }
  catch (e) { return err(401, "Token inválido o expirado"); }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 2. Verificar api_access habilitado + IP
  const { data: access } = await supabase
    .from("api_access")
    .select("id, is_enabled, allowed_ips, credentials_changed_at")
    .eq("id", payload.api_access_id)
    .single();

  if (!access || !access.is_enabled) return err(403, "Acceso API deshabilitado");
  // Tokens emitidos antes de habilitar el acceso o de cambiar la contraseña
  if (access.credentials_changed_at
      && (payload.iat ?? 0) < Math.floor(new Date(access.credentials_changed_at).getTime() / 1000)) {
    return err(401, "Token inválido o expirado");
  }

  const clientIp = getClientIp(req);
  if (access.allowed_ips?.length > 0 && !access.allowed_ips.includes(clientIp)) {
    return err(403, `IP no autorizada: ${clientIp}`);
  }

  // 3. Parsear body
  let body: { amount?: number; concept?: string; description?: string };
  try { body = await req.json(); }
  catch { return err(400, "Body JSON inválido"); }

  const { amount, concept, description } = body;
  if (!amount || amount <= 0) return err(400, "amount debe ser mayor a 0");
  if (!concept) return err(400, "concept es requerido");

  // 4. Obtener datos de la cuenta
  const { data: accountData } = await supabase
    .from("accounts")
    .select("id, cvu, alias, status, users(first_name, last_name)")
    .eq("id", payload.account_id)
    .single();

  if (!accountData) return err(404, "Cuenta no encontrada");
  if (accountData.status !== "active") return err(403, "Cuenta inactiva");

  const holderName = accountData.users
    ? `${(accountData.users as any).first_name} ${(accountData.users as any).last_name}`
    : "Titular";

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutos

  // 5. Insertar QR con datos temporales para obtener el ID real de la DB
  const { data: qrRecord, error: qrError } = await supabase
    .from("qr_codes")
    .insert({
      account_id: accountData.id,
      qr_data: "pending",
      qr_hash: "pending",
      qr_type: "dynamic",
      amount: amount,
      concept: concept,
      expires_at: expiresAt.toISOString(),
      max_uses: 1,
      is_active: true,
      times_used: 0,
    })
    .select("id")
    .single();

  if (qrError || !qrRecord) return err(500, "Error generando el QR");

  // 6. Construir qr_data con el ID real de la DB
  const qrData = JSON.stringify({
    version: "1.0",
    type: "dynamic",
    account_id: accountData.id,
    cvu: accountData.cvu,
    alias: accountData.alias,
    holder_name: holderName,
    amount: amount,
    concept: concept,
    description: description ?? "",
    qr_order_id: qrRecord.id,    // ← ID real, consistente con la respuesta
    expires_at: expiresAt.toISOString(),
  });

  const qrHash = await generateHash(qrData);

  // 7. Actualizar el registro con qr_data y hash correctos
  await supabase
    .from("qr_codes")
    .update({ qr_data: qrData, qr_hash: qrHash })
    .eq("id", qrRecord.id);

  // 8. Loguear + actualizar last_used_at
  await Promise.all([
    supabase.from("api_request_logs").insert({
      api_access_id: access.id, endpoint: "/api-cashin-qr", method: "POST",
      ip_address: clientIp, user_agent: req.headers.get("user-agent"),
      status_code: 200, response_time_ms: Date.now() - start,
    }),
    supabase.from("api_access")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", access.id),
  ]);

  // 9. Responder
  return ok({
    qr_code: qrData,
    qr_order_id: qrRecord.id,   // ← mismo ID que dentro del qr_code
    expires_at: expiresAt.toISOString(),
  });
});