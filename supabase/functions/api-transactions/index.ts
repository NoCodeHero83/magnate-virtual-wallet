// ============================================================
// GET /functions/v1/api-transactions
// Devuelve el historial de transacciones de la cuenta
//
// Headers: Authorization: Bearer <token>
// Query params:
//   date_from:  string YYYY-MM-DD (requerido)
//   date_to:    string YYYY-MM-DD (requerido)
//   operation:  string (opcional) - filtrar por tipo de operación
//   paginate:   0|1 (opcional, default 0)
//   page:       number (opcional, default 1, requiere paginate=1)
//
// Returns: {
//   "status": "ok",
//   "transactions": [...],
//   // solo si paginate=1:
//   "number_of_results": number,
//   "page": number,
//   "pages": number,
//   "pagination": number
// }
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Sin valor por defecto: si falta el secreto, ningún token es válido
const JWT_SECRET = Deno.env.get("API_JWT_SECRET") ?? "";
const PAGE_SIZE = 20;

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

  // 3. Parsear query params
  const url = new URL(req.url);
  const date_from = url.searchParams.get("date_from");
  const date_to   = url.searchParams.get("date_to");
  const operation = url.searchParams.get("operation");
  const paginate  = url.searchParams.get("paginate") === "1";
  const page      = Math.max(1, parseInt(url.searchParams.get("page") ?? "1"));

  if (!date_from || !date_to) {
    return err(400, "date_from y date_to son requeridos (formato YYYY-MM-DD)");
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date_from) || !dateRegex.test(date_to)) {
    return err(400, "Formato de fecha inválido. Use YYYY-MM-DD");
  }
  if (date_from > date_to) {
    return err(400, "date_from no puede ser mayor a date_to");
  }

  // 4. Construir query
  let query = supabase
    .from("transactions")
    .select(`
      id,
      amount,
      currency,
      concept,
      status,
      reference_number,
      created_at,
      completed_at,
      from_account_id,
      to_account_id,
      external_cvu,
      external_cbu,
      external_alias,
      external_holder_name,
      payment_method,
      transaction_types!inner(code, name, category)
    `)
    .or(`from_account_id.eq.${payload.account_id},to_account_id.eq.${payload.account_id}`)
    .gte("created_at", `${date_from}T00:00:00.000Z`)
    .lte("created_at", `${date_to}T23:59:59.999Z`)
    .order("created_at", { ascending: false });

  if (operation) {
    query = query.eq("transaction_types.code", operation);
  }

  // 5. Ejecutar con o sin paginación
  let transactions: any[] = [];
  let totalCount = 0;

  if (paginate) {
    const from = (page - 1) * PAGE_SIZE;
    const to   = from + PAGE_SIZE - 1;
    const { data, error, count } = await (query as any).range(from, to);
    if (error) return err(500, "Error consultando transacciones");
    transactions = data ?? [];
    totalCount = count ?? 0;
  } else {
    const { data, error } = await (query as any).limit(500);
    if (error) return err(500, "Error consultando transacciones");
    transactions = data ?? [];
    totalCount = transactions.length;
  }

  // 6. Formatear al estilo de la doc de referencia
  const formatted = transactions.map((tx: any) => {
    const isIncome = tx.to_account_id === payload.account_id;
    const txType   = tx.transaction_types;
    const holder   = tx.external_holder_name
      ?? (isIncome ? "Transferencia recibida" : "Transferencia enviada");
    const cvuCbu   = tx.external_cvu ?? tx.external_cbu ?? tx.external_alias ?? "";

    return {
      id: tx.id,
      income: isIncome ? 1 : 0,
      date: tx.created_at,
      amount: Number(tx.amount),
      currency: tx.currency ?? "ARS",
      operation: txType?.code ?? "unknown",
      operation_name: txType?.name ?? "",
      concept: tx.concept ?? "",
      holder,
      cvu_cbu: cvuCbu,
      payment_method: tx.payment_method ?? "",
      reference_number: tx.reference_number ?? "",
      status: tx.status,
    };
  });

  // 7. Loguear + actualizar last_used_at
  await Promise.all([
    supabase.from("api_request_logs").insert({
      api_access_id: access.id, endpoint: "/api-transactions", method: "GET",
      ip_address: clientIp, user_agent: req.headers.get("user-agent"),
      status_code: 200, response_time_ms: Date.now() - start,
    }),
    supabase.from("api_access")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", access.id),
  ]);

  // 8. Responder
  const response: Record<string, any> = { transactions: formatted };

  if (paginate) {
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);
    response.number_of_results = totalCount;
    response.page = page;
    response.pages = totalPages;
    response.pagination = PAGE_SIZE;
  }

  return ok(response);
});