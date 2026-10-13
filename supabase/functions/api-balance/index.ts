// ============================================================
// GET /functions/v1/api-balance
// Retorna el balance de la cuenta del usuario autenticado
//
// Headers: Authorization: Bearer <token>
// Returns: { "status": "ok", "amount": number }
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
    "HMAC", key,
    base64urlDecode(parts[2]),
    enc.encode(`${parts[0]}.${parts[1]}`)
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
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(status: number, message: string): Response {
  return new Response(JSON.stringify({ status: "error", message }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function getClientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0].trim()
    ?? req.headers.get("x-real-ip") ?? "unknown";
}

// ─── Handler principal ────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Authorization" },
    });
  }

  if (req.method !== "GET") return err(405, "Método no permitido");

  const start = Date.now();

  // 1. Verificar token
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return err(401, "Token requerido");

  let payload: Record<string, any>;
  try {
    payload = await verifyJWT(authHeader.slice(7));
  } catch (e) {
    return err(401, "Token inválido o expirado");
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 2. Verificar que api_access sigue habilitado y chequear IP
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

  // 3. Obtener balance de la cuenta
  const { data: account, error } = await supabase
    .from("accounts")
    .select("balance, status")
    .eq("id", payload.account_id)
    .single();

  if (error || !account) return err(404, "Cuenta no encontrada");
  if (account.status !== "active") return err(403, "Cuenta inactiva");

  // 4. Loguear + actualizar last_used_at (en paralelo, no bloquea)
  await Promise.all([
    supabase.from("api_request_logs").insert({
      api_access_id: access.id,
      endpoint: "/api-balance",
      method: "GET",
      ip_address: clientIp,
      user_agent: req.headers.get("user-agent"),
      status_code: 200,
      response_time_ms: Date.now() - start,
    }),
    supabase.from("api_access")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", access.id),
  ]);

  // 5. Responder — amount como número (igual que TelePagos)
  return ok({ amount: Number(account.balance) });
});