// ============================================================
// GET /functions/v1/api-transaction/{reference_number}
// Devuelve el detalle de una transacción por su reference_number
//
// Headers: Authorization: Bearer <token>
// Params:  reference_number en la URL (ej: TRX-20260312-E915313C)
//
// Returns: { "status": "ok", "transaction": { ... } }
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Handler ──────────────────────────────────────────────────────────────────

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

  // 3. Extraer reference_number de la URL
  // La URL llega como: /api-transaction/TRX-20260312-E915313C
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const referenceNumber = pathParts[pathParts.length - 1];

  if (!referenceNumber || !referenceNumber.startsWith("TRX-")) {
    return err(400, "reference_number inválido. Formato esperado: TRX-YYYYMMDD-XXXXXXXX");
  }

  // 4. Normalizar: quitar el sufijo -IN si el usuario lo incluyó
  const baseReference = referenceNumber.replace(/-IN$/, "");

  // 5. Buscar ambas legs de la transacción (saliente + entrante)
  // Buscamos por baseReference y baseReference-IN
  const { data: txRows, error: txError } = await supabase
    .from("transactions")
    .select(`
      id,
      transaction_type_id,
      from_account_id,
      to_account_id,
      external_cvu,
      external_cbu,
      external_alias,
      external_holder_name,
      amount,
      currency,
      concept,
      payment_method,
      payment_reference,
      status,
      commission_amount,
      net_amount,
      reference_number,
      metadata,
      created_at,
      completed_at,
      failed_at,
      failure_reason,
      transaction_types(code, name, category)
    `)
    .in("reference_number", [baseReference, `${baseReference}-IN`]);

  if (txError) return err(500, "Error consultando la transacción");
  if (!txRows || txRows.length === 0) return err(404, `Transacción no encontrada: ${baseReference}`);

  // 6. Verificar que la transacción pertenece a la cuenta del token
  const belongsToAccount = txRows.some(tx =>
    tx.from_account_id === payload.account_id ||
    tx.to_account_id === payload.account_id
  );
  if (!belongsToAccount) return err(403, "No tenés acceso a esta transacción");

  // 7. Identificar la leg principal (saliente = sin -IN, entrante = con -IN)
  const outboundTx = txRows.find(tx => tx.reference_number === baseReference);
  const inboundTx  = txRows.find(tx => tx.reference_number === `${baseReference}-IN`);

  // La "principal" desde el punto de vista del usuario autenticado
  const isIncome = inboundTx?.to_account_id === payload.account_id;
  const mainTx   = isIncome ? inboundTx : (outboundTx ?? txRows[0]);

  if (!mainTx) return err(404, "Transacción no encontrada");

  // 8. Resolver datos de cuentas involucradas
  // Cuenta origen
  let fromData: Record<string, any> | null = null;
  if (mainTx.from_account_id) {
    const { data: fromAccount } = await supabase
      .from("accounts")
      .select("cvu, cbu, alias, users(first_name, last_name)")
      .eq("id", mainTx.from_account_id)
      .single();
    if (fromAccount) {
      fromData = {
        account_id: mainTx.from_account_id,
        cvu: fromAccount.cvu,
        alias: fromAccount.alias,
        holder_name: fromAccount.users
          ? `${(fromAccount.users as any).first_name} ${(fromAccount.users as any).last_name}`
          : null,
        type: "internal",
      };
    }
  } else if (mainTx.metadata?.from_account_id) {
    // En la leg entrante, el origen está en metadata
    const { data: fromAccount } = await supabase
      .from("accounts")
      .select("cvu, alias, users(first_name, last_name)")
      .eq("id", mainTx.metadata.from_account_id)
      .single();
    if (fromAccount) {
      fromData = {
        account_id: mainTx.metadata.from_account_id,
        cvu: fromAccount.cvu,
        alias: fromAccount.alias,
        holder_name: fromAccount.users
          ? `${(fromAccount.users as any).first_name} ${(fromAccount.users as any).last_name}`
          : null,
        type: "internal",
      };
    }
  }

  // Cuenta destino
  let toData: Record<string, any> | null = null;
  if (mainTx.to_account_id) {
    const { data: toAccount } = await supabase
      .from("accounts")
      .select("cvu, cbu, alias, users(first_name, last_name)")
      .eq("id", mainTx.to_account_id)
      .single();
    if (toAccount) {
      toData = {
        account_id: mainTx.to_account_id,
        cvu: toAccount.cvu,
        alias: toAccount.alias,
        holder_name: toAccount.users
          ? `${(toAccount.users as any).first_name} ${(toAccount.users as any).last_name}`
          : null,
        type: "internal",
      };
    }
  } else if (mainTx.external_cvu || mainTx.external_cbu || mainTx.external_alias) {
    // Destino externo
    toData = {
      account_id: null,
      cvu: mainTx.external_cvu ?? null,
      cbu: mainTx.external_cbu ?? null,
      alias: mainTx.external_alias ?? null,
      holder_name: mainTx.external_holder_name ?? "Cuenta Externa",
      type: "external",
    };
  } else if (mainTx.metadata?.to_account_id) {
    // Destino en metadata (leg entrante)
    const { data: toAccount } = await supabase
      .from("accounts")
      .select("cvu, alias, users(first_name, last_name)")
      .eq("id", mainTx.metadata.to_account_id)
      .single();
    if (toAccount) {
      toData = {
        account_id: mainTx.metadata.to_account_id,
        cvu: toAccount.cvu,
        alias: toAccount.alias,
        holder_name: toAccount.users
          ? `${(toAccount.users as any).first_name} ${(toAccount.users as any).last_name}`
          : null,
        type: "internal",
      };
    }
  }

  const txType = (mainTx as any).transaction_types;

  // 9. Construir respuesta
  const transaction = {
    id: mainTx.id,
    reference_number: baseReference,
    income: isIncome ? 1 : 0,
    type: txType?.code ?? "unknown",
    type_name: txType?.name ?? "",
    status: mainTx.status,
    amount: Number(mainTx.amount),
    currency: mainTx.currency ?? "ARS",
    net_amount: Number(mainTx.net_amount),
    commission: Number(mainTx.commission_amount ?? 0),
    concept: mainTx.concept ?? "",
    payment_method: mainTx.payment_method ?? "",
    from: fromData,
    to: toData,
    dates: {
      created_at: mainTx.created_at,
      completed_at: mainTx.completed_at ?? null,
      failed_at: mainTx.failed_at ?? null,
    },
    failure_reason: mainTx.failure_reason ?? null,
  };

  // 10. Loguear + actualizar last_used_at
  await Promise.all([
    supabase.from("api_request_logs").insert({
      api_access_id: access.id, endpoint: `/api-transaction/${baseReference}`, method: "GET",
      ip_address: clientIp, user_agent: req.headers.get("user-agent"),
      status_code: 200, response_time_ms: Date.now() - start,
    }),
    supabase.from("api_access")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", access.id),
  ]);

  return ok({ transaction });
});