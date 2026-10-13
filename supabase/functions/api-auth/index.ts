// ============================================================
// POST /functions/v1/api-auth
// Autenticación de usuarios para acceso a la API
//
// Body:    { "client_id": string, "password": string }
// Returns: { "status": "ok", "token": string, "expires_at": number }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sin valor por defecto: si falta el secreto, ningún token es válido
const JWT_SECRET = Deno.env.get("API_JWT_SECRET") ?? "";
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días

// ─── Utilidades JWT ───────────────────────────────────────────────────────────

function base64url(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJWT(payload: object): Promise<string> {
  if (!JWT_SECRET) throw new Error("API_JWT_SECRET no configurado");
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body   = base64url(enc.encode(JSON.stringify(payload)));
  const input  = `${header}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(input));
  return `${input}.${base64url(new Uint8Array(sig))}`;
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
      headers: { ...CORS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }

  if (req.method !== "POST") return err(405, "Método no permitido");

  const start = Date.now();

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 1. Parsear body
  let body: { client_id?: string; password?: string };
  try { body = await req.json(); }
  catch { return err(400, "Body JSON inválido"); }

  const { client_id, password } = body;
  if (!client_id || !password) return err(400, "client_id y password son requeridos");

  // 2-3. client_id + contraseña, validados en la BD (bcrypt, 5 intentos cada 15 min)
  if (typeof client_id !== "string" || typeof password !== "string") return err(400, "client_id y password son requeridos");
  const { data: check, error: checkError } = await supabase.rpc("api_auth_check", {
    p_client_id: client_id,
    p_password: password,
  });
  if (checkError || !check) return err(500, "No se pudo validar las credenciales");
  if (!check.success) {
    if (check.error === "LOCKED") {
      const minutes = Math.max(1, Math.ceil((check.retry_after_seconds ?? 900) / 60));
      return err(429, `Demasiados intentos fallidos. Intentá nuevamente en ${minutes} minutos.`);
    }
    if (check.error === "DISABLED") return err(403, "Acceso API deshabilitado. Contactá al soporte.");
    return err(401, "Credenciales inválidas");
  }
  const access = {
    id: check.api_access_id as string,
    user_id: check.user_id as string,
    client_id: check.client_id as string,
    allowed_ips: (check.allowed_ips ?? []) as string[],
  };

  // 4. Verificar IP whitelist
  const clientIp = getClientIp(req);
  if (access.allowed_ips?.length > 0 && !access.allowed_ips.includes(clientIp)) {
    return err(403, `IP no autorizada: ${clientIp}`);
  }

  // 5. Obtener account activa del usuario
  const { data: account } = await supabase
    .from("accounts")
    .select("id")
    .eq("user_id", access.user_id)
    .eq("status", "active")
    .eq("is_primary", true)
    .single();

  if (!account) return err(404, "No se encontró una cuenta activa para este usuario");

  // 6. Generar JWT
  const now = Math.floor(Date.now() / 1000);
  const expires_at = now + TOKEN_TTL_SECONDS;
  const token = await signJWT({
    client_id: access.client_id,
    api_access_id: access.id,
    user_id: access.user_id,
    account_id: account.id,
    iat: now,
    exp: expires_at,
  });

  // 7. Actualizar last_used_at + loguear
  await Promise.all([
    supabase.from("api_access").update({ last_used_at: new Date().toISOString() }).eq("id", access.id),
    supabase.from("api_request_logs").insert({
      api_access_id: access.id, endpoint: "/api-auth", method: "POST",
      ip_address: clientIp, user_agent: req.headers.get("user-agent"),
      status_code: 200, response_time_ms: Date.now() - start,
    }),
  ]);

  return ok({ token, expires_at });
});