// ============================================================
// POST /functions/v1/api-setup
// Gestiona la configuración del acceso API del usuario
//
// Requiere: JWT de Supabase (anon key, usuario autenticado)
//           y el PIN del usuario para enable / update_password / update_ips
//           (con solo una sesión robada no se puede abrir la API: daría
//           transferencias sin PIN ni dispositivo de confianza).
//
// Actions:
//   "enable"           → Crea o habilita el api_access
//   "disable"          → Deshabilita el api_access
//   "update_password"  → Actualiza la contraseña API
//   "update_ips"       → Actualiza la whitelist de IPs
// ============================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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

// Mensajes de _check_pin
function pinError(result: { error?: string; attempts_left?: number }): Response {
  if (result?.error === "INVALID_PIN") {
    return err(403, `PIN incorrecto. Intentos restantes: ${result.attempts_left ?? 0}`);
  }
  if (result?.error === "PIN_LOCKED") {
    return err(429, "Demasiados intentos incorrectos. Espera unos minutos antes de volver a intentar.");
  }
  return err(403, "No se pudo validar el PIN");
}

// bcrypt, calculado en la BD
async function hashPassword(supabaseAdmin: ReturnType<typeof createClient>, password: string): Promise<string> {
  const { data, error } = await supabaseAdmin.rpc("_hash_api_password", { p_password: password });
  if (error || typeof data !== "string") throw new Error("No se pudo procesar la contraseña");
  return data;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return err(405, "Método no permitido");

  // 1. Autenticar con JWT de Supabase (el usuario de la app)
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return err(401, "Token requerido");

  // Cliente con service role para operaciones privilegiadas
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  // Cliente con el JWT del usuario para obtener su uid
  const supabaseUser = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );

  // 2. Obtener usuario autenticado
  const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
  if (userError || !user) return err(401, "Usuario no autenticado");

  // 3. Parsear body
  let body: {
    action: string;
    client_id_suffix?: string;
    password?: string;
    allowed_ips?: string[];
    pin?: string;
  };
  try { body = await req.json(); }
  catch { return err(400, "Body JSON inválido"); }

  const { action } = body;
  if (!action) return err(400, "action es requerido");

  // Todo menos deshabilitar exige el PIN, validado en la BD (con bloqueo por intentos)
  if (action !== "disable") {
    if (typeof body.pin !== "string" || !/^\d{6}$/.test(body.pin)) return err(400, "Ingresá tu PIN de 6 dígitos");
    const { data: pinResult, error: pinRpcError } = await supabaseAdmin.rpc("_check_pin", {
      p_user_id: user.id,
      p_pin: body.pin,
    });
    if (pinRpcError) return err(500, "No se pudo validar el PIN");
    if (!pinResult?.success) return pinError(pinResult);
  }

  // Aviso por email de cada cambio (si no fue el usuario, puede reaccionar)
  const notify = async (detail: string) => {
    const { error } = await supabaseAdmin.rpc("enqueue_notification", {
      p_user_id: user.id,
      p_notification_type: "api_access_changed",
      p_data: { detail },
      p_related_transaction_id: null,
    });
    if (error) console.error("enqueue_notification error:", error.message);
  };

  // 4. Obtener api_access existente
  const { data: existing } = await supabaseAdmin
    .from("api_access")
    .select("id, is_enabled, client_id")
    .eq("user_id", user.id)
    .maybeSingle();

  // ── ACTION: enable ────────────────────────────────────────────────────────

  if (action === "enable") {
    const { client_id_suffix, password } = body;

    if (!client_id_suffix) return err(400, "client_id_suffix es requerido");
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(client_id_suffix)) return err(400, "El sufijo solo puede tener letras, números, - y _");
    if (!password) return err(400, "password es requerido");

    // Validar contraseña
    if (password.length < 8) return err(400, "La contraseña debe tener al menos 8 caracteres");
    if (!/[A-Z]/.test(password)) return err(400, "La contraseña debe tener al menos una mayúscula");
    if (!/[0-9]/.test(password)) return err(400, "La contraseña debe tener al menos un número");
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return err(400, "La contraseña debe tener al menos un carácter especial");

    // Construir client_id: mag_{shortUserId}_{sufijo}
    const shortUserId = user.id.replace(/-/g, "").slice(0, 8);
    const client_id = `mag_${shortUserId}_${client_id_suffix}`;

    // Verificar que el client_id no esté tomado por otro usuario
    const { data: taken } = await supabaseAdmin
      .from("api_access")
      .select("id")
      .eq("client_id", client_id)
      .neq("user_id", user.id)
      .maybeSingle();

    if (taken) return err(409, "Ese nombre de usuario API ya está en uso. Elegí otro sufijo.");

    const passwordHash = await hashPassword(supabaseAdmin, password);

    if (existing) {
      // Ya tiene registro → actualizar y habilitar
      const { error } = await supabaseAdmin
        .from("api_access")
        .update({
          is_enabled: true,
          client_id,
          api_password_hash: passwordHash,
          enabled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          credentials_changed_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (error) return err(500, "Error habilitando el acceso API");
    } else {
      // No tiene registro → crear
      const { error } = await supabaseAdmin
        .from("api_access")
        .insert({
          user_id: user.id,
          client_id,
          is_enabled: true,
          api_password_hash: passwordHash,
          allowed_ips: [],
          rate_limit_per_minute: 60,
          enabled_at: new Date().toISOString(),
          credentials_changed_at: new Date().toISOString(),
        });

      if (error) return err(500, "Error creando el acceso API");
    }

    // Obtener el registro actualizado
    const { data: updated } = await supabaseAdmin
      .from("api_access")
      .select("id, client_id, is_enabled, allowed_ips, rate_limit_per_minute, created_at")
      .eq("user_id", user.id)
      .single();

    await notify(`Se habilitó el acceso API de tu cuenta Magnate (usuario API: ${client_id}).`);
    return ok({ client_id, api_access: updated });
  }

  // ── ACTION: disable ───────────────────────────────────────────────────────

  if (action === "disable") {
    if (!existing) return err(404, "No tenés acceso API configurado");

    const { error } = await supabaseAdmin
      .from("api_access")
      .update({ is_enabled: false, updated_at: new Date().toISOString() })
      .eq("id", existing.id);

    if (error) return err(500, "Error deshabilitando el acceso API");
    if (existing.is_enabled) await notify("Se deshabilitó el acceso API de tu cuenta Magnate.");
    return ok({ message: "Acceso API deshabilitado" });
  }

  // ── ACTION: update_password ───────────────────────────────────────────────

  if (action === "update_password") {
    if (!existing) return err(404, "No tenés acceso API configurado");
    if (!existing.is_enabled) return err(403, "El acceso API está deshabilitado");

    const { password } = body;
    if (!password) return err(400, "password es requerido");

    if (password.length < 8) return err(400, "La contraseña debe tener al menos 8 caracteres");
    if (!/[A-Z]/.test(password)) return err(400, "La contraseña debe tener al menos una mayúscula");
    if (!/[0-9]/.test(password)) return err(400, "La contraseña debe tener al menos un número");
    if (!/[!@#$%^&*(),.?":{}|<>]/.test(password)) return err(400, "La contraseña debe tener al menos un carácter especial");

    const passwordHash = await hashPassword(supabaseAdmin, password);

    const { error } = await supabaseAdmin
      .from("api_access")
      .update({
        api_password_hash: passwordHash,
        updated_at: new Date().toISOString(),
        credentials_changed_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) return err(500, "Error actualizando la contraseña");
    await notify("Se cambió la contraseña del acceso API de tu cuenta Magnate.");
    return ok({ message: "Contraseña actualizada correctamente" });
  }

  // ── ACTION: update_ips ────────────────────────────────────────────────────

  if (action === "update_ips") {
    if (!existing) return err(404, "No tenés acceso API configurado");
    if (!existing.is_enabled) return err(403, "El acceso API está deshabilitado");

    const { allowed_ips } = body;
    if (!Array.isArray(allowed_ips)) return err(400, "allowed_ips debe ser un array");
    if (allowed_ips.length > 50) return err(400, "Máximo 50 IPs");

    // Validar formato de cada IP
    const ipv4Regex = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    for (const ip of allowed_ips) {
      if (typeof ip !== "string" || !ipv4Regex.test(ip)) return err(400, "Hay una IP inválida en la lista");
    }

    const { error } = await supabaseAdmin
      .from("api_access")
      .update({
        allowed_ips,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) return err(500, "Error actualizando las IPs");
    await notify(allowed_ips.length === 0
      ? "Se quitó la lista de IPs permitidas del acceso API: ahora acepta cualquier IP."
      : `Se actualizaron las IPs permitidas del acceso API (${allowed_ips.length}).`);
    return ok({ message: "IPs actualizadas correctamente", allowed_ips });
  }

  return err(400, `Acción desconocida: ${action}`);
});