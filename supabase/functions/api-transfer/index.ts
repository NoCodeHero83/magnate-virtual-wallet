// ============================================================
// POST /functions/v1/api-transfer
// Genera una transferencia saliente (cashout)
//
// Headers: Authorization: Bearer <token>
// Body: {
//   "cvu":          string (destino, usar cvu O alias, no ambos),
//   "alias":        string (destino, usar cvu O alias, no ambos),
//   "amount":       number,
//   "concept":      string,
//   "description":  string (opcional),
//   "reference_id": string (único por transacción, para idempotencia)
// }
// Returns: { "status": "ok", "id": string, "reference_number": string, "amount": number,
//            "amount_sent": number, "commission": number, "total_debit": number, "new_balance": number }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const JWT_SECRET = Deno.env.get("API_JWT_SECRET") ?? "change_me_in_production";

// ─── Utilidades JWT ───────────────────────────────────────────────────────────

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded);
  return new Uint8Array(bin.split("").map((c) => c.charCodeAt(0)));
}

async function verifyJWT(token: string): Promise<Record<string, any>> {
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
      headers: { ...CORS, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Authorization, Content-Type" },
    });
  }

  if (req.method !== "POST") return err(405, "Método no permitido");

  const start = Date.now();

  // 1. Verificar token
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return err(401, "Token requerido");

  let payload: Record<string, any>;
  try {
    payload = await verifyJWT(authHeader.slice(7));
  } catch (e) {
    return err(401, `Token inválido: ${e.message}`);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // 2. Verificar api_access habilitado + IP
  const { data: access } = await supabase
    .from("api_access")
    .select("id, is_enabled, allowed_ips")
    .eq("id", payload.api_access_id)
    .single();

  if (!access || !access.is_enabled) return err(403, "Acceso API deshabilitado");

  const clientIp = getClientIp(req);
  if (access.allowed_ips?.length > 0 && !access.allowed_ips.includes(clientIp)) {
    return err(403, `IP no autorizada: ${clientIp}`);
  }

  // 3. Parsear body
  let body: {
    cvu?: string;
    alias?: string;
    amount?: number;
    concept?: string;
    description?: string;
    reference_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return err(400, "Body JSON inválido");
  }

  const { cvu, alias, amount, concept, description, reference_id } = body;

  // 4. Validaciones de campos
  if (!amount || amount <= 0) return err(400, "amount debe ser mayor a 0");
  if (!concept) return err(400, "concept es requerido");
  if (!reference_id) return err(400, "reference_id es requerido");
  if (!cvu && !alias) return err(400, "Debe informar cvu o alias como destino");
  if (cvu && alias) return err(400, "Debe informar cvu o alias, no ambos");

  const to_identifier = cvu ?? alias!;
  const payment_method = cvu ? "cvu" : "alias";

  // 5. Verificar idempotencia — si ya existe una tx con este reference_id, devolverla
  const { data: existingTx } = await supabase
    .from("transactions")
    .select("id, reference_number, status")
    .eq("payment_reference", reference_id)
    .eq("from_account_id", payload.account_id)
    .maybeSingle();

  if (existingTx) {
    // Transacción ya procesada, devolver resultado idempotente
    return ok({
      id: existingTx.id,
      reference_number: existingTx.reference_number,
      status: existingTx.status,
      idempotent: true,
    });
  }

  // 6. Ejecutar transferencia usando la función process_transfer de la DB
  // Nota: process_transfer valida saldo, límites, bloquea cuentas y reconcilia balance
  const { data: result, error: transferError } = await supabase.rpc("process_transfer", {
    p_from_account_id: payload.account_id,
    p_to_identifier: to_identifier,
    p_amount: amount,
    p_concept: concept + (description ? ` - ${description}` : ""),
    p_payment_method: payment_method,
    p_device_id: null,
    p_ip_address: clientIp,
  });

  if (transferError) {
    // Mapear errores conocidos de process_transfer a mensajes amigables
    const msg = transferError.message ?? "";
    let statusCode = 400;
    let userMessage = "Error procesando transferencia";

    if (msg.includes("INSUFFICIENT_BALANCE")) {
      userMessage = "Saldo insuficiente (incluye la comisión)";
    } else if (msg.includes("AMOUNT_TOO_LOW_FOR_FEE")) {
      userMessage = "El monto no alcanza para cubrir la comisión";
    } else if (msg.includes("DESTINATION_NOT_FOUND")) {
      userMessage = "No existe una cuenta con ese alias";
      statusCode = 404;
    } else if (msg.includes("DESTINATION_NOT_ACTIVE")) {
      userMessage = "La cuenta destino no está habilitada para recibir transferencias";
      statusCode = 422;
    } else if (msg.includes("MONTHLY_LIMIT_EXCEEDED")) {
      userMessage = "Excede el límite mensual de transferencias";
    } else if (msg.includes("DAILY_LIMIT_EXCEEDED")) {
      userMessage = "Excede el límite diario de transferencias";
    } else if (msg.includes("PER_TRANSACTION_LIMIT_EXCEEDED")) {
      userMessage = "Excede el límite por transacción";
    } else if (msg.includes("ACCOUNT_NOT_ACTIVE")) {
      userMessage = "La cuenta de origen no está activa";
      statusCode = 403;
    } else if (msg.includes("SAME_ACCOUNT")) {
      userMessage = "No podés transferir a tu propia cuenta";
    } else if (msg.includes("UNAUTHORIZED")) {
      userMessage = "No autorizado";
      statusCode = 403;
    }

    await supabase.from("api_request_logs").insert({
      api_access_id: access.id, endpoint: "/api-transfer", method: "POST",
      ip_address: clientIp, user_agent: req.headers.get("user-agent"),
      status_code: statusCode, response_time_ms: Date.now() - start,
    });

    return err(statusCode, userMessage);
  }

  // 7. Actualizar payment_reference con el reference_id del cliente para idempotencia futura
  if (result?.transaction_id) {
    await supabase
      .from("transactions")
      .update({ payment_reference: reference_id })
      .eq("id", result.transaction_id);
  }

  // 8. Loguear éxito + actualizar last_used_at
  await Promise.all([
    supabase.from("api_request_logs").insert({
      api_access_id: access.id, endpoint: "/api-transfer", method: "POST",
      ip_address: clientIp, user_agent: req.headers.get("user-agent"),
      status_code: 200, response_time_ms: Date.now() - start,
    }),
    supabase.from("api_access")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", access.id),
  ]);

  // 9. Responder
  return ok({
    id: result.transaction_id,
    reference_number: result.reference_number,
    amount: result.amount,
    amount_sent: result.amount_sent,
    commission: result.commission,
    total_debit: result.total_debit,
    new_balance: result.new_balance,
    is_external: result.is_external,
    status: result.status,
  });
});