import { supabase } from "../lib/supabase";
import bcrypt from "bcryptjs";
import * as Crypto from "expo-crypto";

// Polyfill for random bytes in React Native for bcryptjs
bcrypt.setRandomFallback((len) => {
  const randomBytes = Crypto.getRandomBytes(len);
  return Array.from(randomBytes);
});

import { encrypt, generateSecurePassword } from "../utils/crypto";
import {
  generateCBU,
  generateCVU,
  generateAlias,
  getEndOfMonth,
} from "../utils/generators";
import {
  User,
  Account,
  UserAuthCredential,
  VerificationStatus,
  UserAccountType,
  UserDevice,
} from "../types/database.types";
import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";
import { Platform } from "react-native";
import Constants from "expo-constants";

export interface LoginCredentials {
  email: string;
  pin: string;
}

export interface CompanyRegisterData {
  company_cuit: string;
  /** YYYY-MM-DD */
  incorporation_date: string;
  legal_entity_type: string;
  legal_name: string;
  trade_name?: string;
}

export interface RegisterData {
  account_type?: UserAccountType;
  nombres: string;
  apellidos: string;
  email: string;
  telefono: string;
  dni: string;
  cuit: string;
  pin: string;
  zapsign_doc_token?: string;
  zapsign_contract_url?: string;
  zapsign_data?: any;
  /** Requerido cuando account_type = 'business' */
  company?: CompanyRegisterData;
}


export interface AuthResult {
  success: boolean;
  error?: string;
  userId?: string;
  requireDeviceVerification?: boolean;
  /** Login en dispositivo nuevo: si se envió un código nuevo (false = vale el anterior) */
  codeSent?: boolean;
  /** Registro: estado con el que quedó la cuenta */
  verificationStatus?: VerificationStatus;
  /** Código enviado por email, solo en el entorno de pruebas con los códigos en pantalla activados */
  debugCode?: string;
}
// Resultado del RPC login_with_pin (el PIN se valida en el servidor)
interface PinLoginResult {
  success: boolean;
  error?:
    | "USER_NOT_FOUND"
    | "SUSPENDED"
    | "CORRUPT_CREDENTIALS"
    | "INVALID_PIN"
    | "PIN_LOCKED"
    | "REJECTED"
    | "NOT_VERIFIED"
    | "MISSING_CREDENTIALS"
    | "UPDATE_REQUIRED"
    | "DEVICE_VERIFICATION_REQUIRED"
    | "CODE_EXPIRED"
    | "CODE_MISMATCH"
    | "TOO_MANY_ATTEMPTS"
    | "INVALID_CODE"
    | "TOO_SOON"
    | "TOO_MANY_REQUESTS"
    | "LOGIN_AGAIN";
  attempts_left?: number;
  /** DEVICE_VERIFICATION_REQUIRED: false si ya había un código reciente (sigue valiendo) */
  code_sent?: boolean;
  /** Entorno de pruebas con los códigos en pantalla activados */
  debug_code?: string;
  /** PIN_LOCKED: segundos hasta poder reintentar */
  retry_after_seconds?: number;
  status_reason?: string | null;
  user_id?: string;
  verification_status?: VerificationStatus;
  account_type?: UserAccountType;
  /** Sesión creada por el servidor (app-login) */
  session?: { access_token: string; refresh_token: string };
}

function pinLoginErrorMessage(result: PinLoginResult): string {
  switch (result.error) {
    case "USER_NOT_FOUND":
      return "Usuario no encontrado";
    case "SUSPENDED":
      return "Esta cuenta se encuentra suspendida.";
    case "CORRUPT_CREDENTIALS":
      return "Datos de seguridad corruptos";
    case "INVALID_PIN":
      return `PIN incorrecto. Intentos restantes: ${result.attempts_left ?? 0}`;
    case "PIN_LOCKED": {
      const minutes = Math.max(1, Math.ceil((result.retry_after_seconds ?? 900) / 60));
      return `Demasiados intentos incorrectos. Por seguridad, espera ${minutes} minuto${minutes === 1 ? "" : "s"} antes de volver a intentar.`;
    }
    case "REJECTED": {
      const reason = result.status_reason ? `\nMotivo: ${result.status_reason}` : "";
      return `Tu solicitud de cuenta fue rechazada.${reason}\nSi crees que es un error, contacta a soporte.`;
    }
    case "NOT_VERIFIED":
      return "Cuenta pendiente de verificación";
    case "MISSING_CREDENTIALS":
      return "Error interno: Credenciales inválidas";
    case "UPDATE_REQUIRED":
      return "Actualiza la app a la última versión para iniciar sesión.";
    case "CODE_EXPIRED":
      return "El código expiró o ya fue usado. Pide uno nuevo.";
    case "CODE_MISMATCH":
      return "El código no corresponde a este dispositivo. Pide uno nuevo.";
    case "TOO_MANY_ATTEMPTS":
      return "Demasiados intentos fallidos. Pide un código nuevo.";
    case "INVALID_CODE":
      return `Código incorrecto. Te quedan ${result.attempts_left ?? 0} intento${result.attempts_left === 1 ? "" : "s"}.`;
    case "TOO_SOON":
      return "Espera un minuto antes de pedir otro código.";
    case "TOO_MANY_REQUESTS":
      return "Pediste demasiados códigos. Intenta de nuevo más tarde.";
    case "LOGIN_AGAIN":
      return "Vuelve a iniciar sesión para recibir un código nuevo.";
    default:
      return "Error desconocido";
  }
}

/**
 * Obtiene o crea un ID único de dispositivo almacenado localmente.
 */
export async function getLocalDeviceId(): Promise<string> {
  const DEVICE_ID_KEY = "MAGNATE_DEVICE_ID";
  try {
    let deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (!deviceId) {
      deviceId = Crypto.randomUUID();
      await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId);
    }
    return deviceId;
  } catch (error) {
    console.error("Error getting/setting device ID:", error);
    return "UNKNOWN_DEVICE";
  }
}

/**
 * Secreto del dispositivo: se genera una vez y nunca sale del teléfono salvo
 * hacia el servidor, que guarda solo su hash. Prueba que el dispositivo es el
 * que se verificó con el código por email.
 */
async function getLocalDeviceSecret(): Promise<string> {
  const DEVICE_SECRET_KEY = "MAGNATE_DEVICE_SECRET";
  let secret = await SecureStore.getItemAsync(DEVICE_SECRET_KEY);
  if (!secret) {
    secret = (Crypto.randomUUID() + Crypto.randomUUID()).replace(/-/g, "");
    await SecureStore.setItemAsync(DEVICE_SECRET_KEY, secret);
  }
  return secret;
}

export interface DeviceDescriptor {
  id: string;
  secret: string;
  name: string | null;
  model: string | null;
  platform: string;
  os_version: string | null;
  app_version: string | null;
}

/** Datos del dispositivo que se envían al servidor (login, verificación, transferencias) */
export async function getDeviceDescriptor(): Promise<DeviceDescriptor> {
  return {
    id: await getLocalDeviceId(),
    secret: await getLocalDeviceSecret(),
    name: Device.deviceName ?? null,
    model: Device.modelName ?? null,
    platform: Platform.OS,
    os_version: Device.osVersion ?? null,
    app_version: Constants.expoConfig?.version ?? null,
  };
}

/** ¿El dispositivo actual sigue siendo de confianza para la sesión actual? */
export async function checkDeviceTrust(): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("check_device_trust", {
      p_device: await getDeviceDescriptor(),
    } as any);
    if (error) {
      console.error("[AUTH] check_device_trust error:", error);
      return false;
    }
    return data === true;
  } catch (error) {
    console.error("[AUTH] Error checking device trust:", error);
    return false;
  }
}

/** Columnas de users que lee la app (los hashes de PIN y contraseña web no son legibles) */
export const USER_COLUMNS = "id, first_name, last_name, email, phone, dni, cuit_cuil, web_access_enabled, web_access_enabled_at, verification_status, zapsign_verification_id, zapsign_verified_at, zapsign_data, created_at, updated_at, photo_url, role, zapsign_contract_url, account_type, status_reason, reviewed_by, reviewed_at, pin_upgrade_required";

/** Llama a la edge function app-login (login con PIN o código de dispositivo nuevo) */
async function callAppLogin(body: Record<string, unknown>): Promise<PinLoginResult | null> {
  const { data, error } = await supabase.functions.invoke("app-login", {
    body: { ...body, device: await getDeviceDescriptor() },
  });
  if (error) {
    // Errores con cuerpo JSON (4xx/5xx): se usa el código que devuelve la función
    try {
      const parsed = await (error as any)?.context?.json?.();
      if (parsed?.error) return parsed as PinLoginResult;
    } catch {
      // sin cuerpo
    }
    return null;
  }
  return data as PinLoginResult;
}

/** Inicia la sesión creada por el servidor */
async function startSession(session: { access_token: string; refresh_token: string }): Promise<AuthResult> {
  const { error } = await supabase.auth.setSession(session);
  if (error) {
    return { success: false, error: "Error al iniciar sesión" };
  }
  return { success: true };
}

export async function loginWithPin(
  email: string,
  pin: string,
): Promise<AuthResult> {
  try {
    const normalizedEmail = email.toLowerCase().trim();

    // El servidor valida el PIN, el estado de la cuenta y el dispositivo, y crea la
    // sesión. Si el dispositivo es nuevo envía un código por email y NO hay sesión
    // hasta validarlo.
    const result = await callAppLogin({ action: "pin", email: normalizedEmail, pin });
    if (!result) {
      return { success: false, error: "Error de conexión" };
    }
    if (result.error === "DEVICE_VERIFICATION_REQUIRED") {
      return {
        success: true,
        requireDeviceVerification: true,
        codeSent: result.code_sent !== false,
        debugCode: result.debug_code,
      };
    }
    if (!result.success || !result.user_id || !result.session) {
      return { success: false, error: pinLoginErrorMessage(result) };
    }

    const signIn = await startSession(result.session);
    if (!signIn.success) return signIn;

    return { success: true, userId: result.user_id, requireDeviceVerification: false };
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/**
 * Valida el código del dispositivo nuevo. Recién ahí el servidor entrega la
 * credencial y el dispositivo queda de confianza.
 */
export async function verifyDeviceLogin(email: string, code: string): Promise<AuthResult> {
  try {
    const normalizedEmail = email.toLowerCase().trim();
    const result = await callAppLogin({ action: "verify_device", email: normalizedEmail, code });
    if (!result) return { success: false, error: "Error de conexión" };
    if (!result.success || !result.user_id || !result.session) {
      return { success: false, error: pinLoginErrorMessage(result) };
    }

    const signIn = await startSession(result.session);
    if (!signIn.success) return signIn;
    return { success: true, userId: result.user_id };
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/** Reenvía el código del dispositivo nuevo (solo si hubo un login reciente con PIN correcto) */
export async function resendDeviceLoginCode(email: string): Promise<AuthResult & { loginAgain?: boolean }> {
  try {
    const { data, error } = await supabase.rpc("resend_device_login_code", {
      p_email: email.toLowerCase().trim(),
      p_device: await getDeviceDescriptor(),
    } as any);
    if (error) return { success: false, error: "Error de conexión" };

    const result = data as PinLoginResult | null;
    if (result?.success) return { success: true, debugCode: result.debug_code };
    return {
      success: false,
      loginAgain: result?.error === "LOGIN_AGAIN",
      error: result ? pinLoginErrorMessage(result) : "Error de conexión",
    };
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}


/**
 * Registro de usuario
 */
export async function registerUser(data: RegisterData): Promise<AuthResult> {
  try {
    const normalizedEmail = data.email.toLowerCase().trim();

    // 1. Hash del PIN first

    const salt = await bcrypt.genSalt(10);
    const pinHash = await bcrypt.hash(data.pin, salt);

    // 2. Prepare metadata and Create user via signUp

    const cleanDni = data.dni.replace(/\D/g, "");
    const cleanCuit = data.cuit.replace(/\D/g, "");
    const cleanPhone = data.telefono.trim();
    const accountType: UserAccountType = data.account_type ?? "personal";

    if (accountType === "business" && !data.company) {
      return { success: false, error: "Faltan los datos de la empresa" };
    }

    const companyMetadata =
      accountType === "business" && data.company
        ? {
            company_cuit: data.company.company_cuit.replace(/\D/g, ""),
            incorporation_date: data.company.incorporation_date,
            legal_entity_type: data.company.legal_entity_type,
            legal_name: data.company.legal_name.trim(),
            trade_name: data.company.trade_name?.trim() || null,
          }
        : {};

    // Generamos password seguro para el auth.users
    const autoPassword = await generateSecurePassword(32);

    const { data: authData, error: authError } = await supabase.auth.signUp({
    email: normalizedEmail,
    password: autoPassword,
      options: {
        data: {
          // user-facing keys (por compatibilidad con triggers existentes)
          nombres: data.nombres.trim(),
          apellidos: data.apellidos.trim(),
          telefono: cleanPhone,
          cuit: cleanCuit,
          dni: cleanDni,
          pin_hash: pinHash,
          // claves canónicas (coinciden con las columnas NOT NULL de public.users)
          first_name: data.nombres.trim(),
          last_name: data.apellidos.trim(),
          phone: cleanPhone,
          cuit_cuil: cleanCuit,
          zapsign_verification_id: data.zapsign_doc_token || null,
          zapsign_contract_url: data.zapsign_contract_url || null,
          zapsign_data: data.zapsign_data || null,
          // Tipo de cuenta + datos de empresa (los valida y guarda el trigger handle_new_user)
          account_type: accountType,
          ...companyMetadata,
        },
      },
});

    if (authError) {
      // Superficializar el error completo de la base de datos (code/hint/details)
      // para poder diagnosticar fallos del trigger de creación de usuario.
      const anyErr = authError as any;
      const code = anyErr?.code ? ` [${anyErr.code}]` : '';
      const hint = anyErr?.hint ? `: ${anyErr.hint}` : '';
      const details = anyErr?.details ? ` | ${anyErr.details}` : '';
      const fullMessage = `${authError.message}${code}${hint}${details}`;
      console.error('[AUTH] signUp error:', anyErr);
      // El trigger de la BD rechaza CUIT de empresa duplicado o datos inválidos;
      // GoTrue lo devuelve como "Database error saving new user"
      if (authError.message.includes("COMPANY_CUIT_EXISTS")) {
        return { success: false, error: "Ya existe una cuenta registrada con el CUIT de esa empresa." };
      }
      if (accountType === "business" && /database error/i.test(authError.message)) {
        return {
          success: false,
          error: "No pudimos crear la cuenta de la empresa. Verifica los datos: puede que el CUIT de la empresa ya esté registrado.",
        };
      }
      return { success: false, error: fullMessage };
    }

    if (!authData.user) {
      return { success: false, error: "Error al crear usuario" };
    }

    const userId = authData.user.id;

    // 3. (REMOVED) Manual insert into public.users is handled by DB Trigger

    // 4. Guardar password encriptado par login automático
    if (authData.session) {
      const encryptedPassword = await encrypt(autoPassword);

      const { error: credError } = await supabase
        .from("user_auth_credentials")
        .insert({
          user_id: userId,
          auto_password_encrypted: encryptedPassword,
        } as any);

      if (credError) {
        const anyErr = credError as any;
        const code = anyErr?.code ? ` [${anyErr.code}]` : '';
        const hint = anyErr?.hint ? `: ${anyErr.hint}` : '';
        console.error('[AUTH] user_auth_credentials insert error:', anyErr);
        // No es bloqueante con el mensaje original; se anota para diagnóstico
        // pero se continúa (el login manual se reintenta al crear la credencial).
        // eslint-disable-next-line no-empty
        void code; void hint;
      }
    }

    // 5. Esperar a que el trigger cree la cuenta y obtener info

    // Reintentos para dar tiempo al trigger
    let accountInfo = null;
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const { data } = await supabase.rpc("get_account_info", {
        p_user_id: userId,
      } as any);
      if (data && (data as any).length > 0) {
        accountInfo = data[0];
        break;
      }
    }

    // 5b. El dispositivo donde se creó la cuenta (email ya verificado con código) queda de confianza
    if (authData.session) {
      const { error: trustError } = await supabase.rpc("trust_signup_device", {
        p_device: await getDeviceDescriptor(),
      } as any);
      if (trustError) console.error("[AUTH] trust_signup_device error:", trustError);
    }

    // 6. Estado real con el que quedó la cuenta (pendiente de aprobación o verificada)
    let verificationStatus: VerificationStatus | undefined;
    if (authData.session) {
      const { data: profile } = await supabase
        .from("users")
        .select("verification_status")
        .eq("id", userId)
        .maybeSingle();
      verificationStatus = (profile as any)?.verification_status;
    }
    if (!verificationStatus) {
      const { data: needsApproval } = await supabase.rpc("signup_requires_approval", {
        p_account_type: accountType,
      } as any);
      verificationStatus = needsApproval === true ? "pending" : "verified";
    }

    return {
      success: true,
      userId,
      verificationStatus,
    };
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/**
 * Crear cuenta por defecto para un usuario
 */
async function createDefaultAccount(userId: string): Promise<AuthResult> {
  try {
    // 1. Obtener account_type_id donde code = 'savings_ars'
    let accountTypeId: string | null = null;

    const { data: accountType, error: typeError } = await supabase
      .from("account_types")
      .select("id")
      .eq("code", "savings_ars")
      .single();

    if (!typeError && accountType) {
      accountTypeId = (accountType as any).id;
    } else {
      // Si no existe, intentar con cualquier tipo activo
      const { data: anyType, error: anyError } = await supabase
        .from("account_types")
        .select("id")
        .eq("is_active", true)
        .limit(1)
        .single();

      if (anyError || !anyType) {
        return { success: false, error: "No hay tipos de cuenta disponibles" };
      }
      accountTypeId = (anyType as any).id;
    }

    if (!accountTypeId) {
      return { success: false, error: "No se pudo determinar tipo de cuenta" };
    }

    // 2. Generar CBU, CVU y alias
    const cbu = generateCBU();
    const cvu = generateCVU();
    const alias = generateAlias(cvu);

    // 3. Insertar cuenta
    const accountInsert = {
      user_id: userId,
      account_type_id: accountTypeId,
      cbu,
      cvu,
      alias,
      balance: 0,
      status: "active" as const,
      is_primary: true,
    };

    const { data: account, error: accountError } = await supabase
      .from("accounts")
      .insert(accountInsert as any)
      .select("id")
      .single();

    if (accountError || !account) {
      return { success: false, error: "Error al crear cuenta" };
    }

    const accountId = (account as any).id;

    // 4. Insertar límites de cuenta
    const now = new Date();
    const endOfMonth = getEndOfMonth();

    const limitsInsert = {
      account_id: accountId,
      monthly_limit: 800000.0,
      monthly_spent: 0,
      current_period_start: now.toISOString(),
      current_period_end: endOfMonth.toISOString(),
      daily_limit: null,
      daily_spent: 0,
      per_transaction_limit: null,
    };

    const { error: limitsError } = await supabase
      .from("account_limits")
      .insert(limitsInsert as any);

    if (limitsError) {
      // No es crítico
    } else {
    }

    return { success: true };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}

// Mensajes de los RPC de cambio de PIN
const PIN_CHANGE_ERRORS: Record<string, string> = {
  INVALID_PIN: "PIN actual incorrecto",
  PIN_LOCKED: "Demasiados intentos incorrectos. Espera unos minutos antes de volver a intentar.",
  CORRUPT_CREDENTIALS: "Datos de seguridad corruptos. Contacta a soporte.",
  TOO_SOON: "Espera un minuto antes de pedir otro código.",
  TOO_MANY_REQUESTS: "Pediste demasiados códigos. Intenta de nuevo más tarde.",
  INVALID_NEW_PIN: "El nuevo PIN debe tener 6 dígitos.",
  SAME_PIN: "El nuevo PIN debe ser distinto al actual.",
  CODE_EXPIRED: "El código expiró o ya fue usado. Empieza de nuevo.",
  TOO_MANY_ATTEMPTS: "Demasiados intentos fallidos con el código. Empieza de nuevo.",
  INVALID_CODE: "Código incorrecto.",
  UNAUTHORIZED: "Sesión inválida. Vuelve a iniciar sesión.",
};

export interface PinChangeResult extends AuthResult {
  /** Código de error del servidor (ej. INVALID_CODE, SAME_PIN) */
  code?: string;
}

const pinChangeResult = (data: any): PinChangeResult => {
  if (data?.success) return { success: true, debugCode: data.debug_code ?? undefined };
  const code = data?.error as string | undefined;
  let error = (code && PIN_CHANGE_ERRORS[code]) || "No se pudo completar la operación";
  if (code === "INVALID_PIN" && typeof data?.attempts_left === "number") {
    error += `. Intentos restantes: ${data.attempts_left}`;
  }
  if (code === "INVALID_CODE" && typeof data?.attempts_left === "number") {
    error += ` Te quedan ${data.attempts_left} intento${data.attempts_left === 1 ? "" : "s"}.`;
  }
  return { success: false, code, error };
};

/**
 * Cambio de PIN, paso 1: el servidor valida el PIN actual y envía un código por email.
 */
export async function requestPinChangeCode(currentPin: string): Promise<PinChangeResult> {
  try {
    const { data, error } = await supabase.rpc("request_pin_change_code", { p_current_pin: currentPin } as any);
    if (error) return { success: false, error: "Error de conexión" };
    return pinChangeResult(data);
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/**
 * Cambio de PIN, paso 2: el servidor valida el código y guarda el nuevo PIN.
 */
export async function confirmPinChange(code: string, newPin: string): Promise<PinChangeResult> {
  try {
    const { data, error } = await supabase.rpc("confirm_pin_change", { p_code: code, p_new_pin: newPin } as any);
    if (error) return { success: false, error: "Error de conexión" };
    return pinChangeResult(data);
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/**
 * PIN olvidado, paso 1: pide un código por email. El servidor responde siempre igual,
 * exista o no el email.
 */
export async function requestPinReset(email: string): Promise<PinChangeResult> {
  try {
    const { data, error } = await supabase.rpc("request_pin_reset", { p_email: email.trim() } as any);
    if (error) return { success: false, error: "Error de conexión" };
    return pinChangeResult(data);
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/**
 * PIN olvidado, paso 2: valida el código y guarda el nuevo PIN.
 */
export async function confirmPinReset(email: string, code: string, newPin: string): Promise<PinChangeResult> {
  try {
    const { data, error } = await supabase.rpc("confirm_pin_reset", {
      p_email: email.trim(),
      p_code: code,
      p_new_pin: newPin,
    } as any);
    if (error) return { success: false, error: "Error de conexión" };
    return pinChangeResult(data);
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/**
 * Get user devices
 */
export async function getUserDevices() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("No authenticated user");

  const { data, error } = await supabase
    .from("user_devices")
    .select("*")
    .eq("user_id", user.id)
    .order("last_active_at", { ascending: false });

  if (error) throw error;
  return data;
}

/**
 * Logout
 */
export async function logout(): Promise<AuthResult> {
  const { error } = await supabase.auth.signOut();
  if (error) {
  }
  return { success: !error, error: error?.message };
}

/**
 * Revocar un dispositivo
 */
export async function revokeDevice(deviceId: string): Promise<AuthResult> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Usuario no autenticado." };

    // El servidor quita la confianza del dispositivo (secreto y verificación)
    const { error } = await supabase.rpc("revoke_device", { p_device_record_id: deviceId } as any);

    if (error) throw error;
    return { success: true };
  } catch (err: any) {
    console.error("Error revoking device:", err);
    return { success: false, error: "No se pudo desvincular el dispositivo." };
  }
}

/**
 * Obtener sesión actual
 */
export async function getCurrentSession() {
  const {
    data: { session },
    error,
  } = await supabase.auth.getSession();
  return { session, error: error?.message };
}

/**
 * Obtener usuario actual de la base de datos
 */
export async function getCurrentUser(userId: string) {
  const { data, error } = await supabase
    .from("users")
    .select(USER_COLUMNS)
    .eq("id", userId)
    .single();

  return { user: data as unknown as User | null, error: error?.message };
}

/**
 * Activa / desactiva el Acceso Web. Activarlo o cambiar la contraseña exige el PIN;
 * la contraseña se guarda hasheada en el servidor (set_web_access).
 */
export async function updateWebAccess(enabled: boolean, pin?: string, password?: string): Promise<{ success: boolean; error?: string }> {
    try {
        const { data, error } = await supabase.rpc("set_web_access", {
            p_enabled: enabled,
            p_pin: pin ?? null,
            p_password: password ?? null,
        } as any);
        if (error) throw error;

        const result = data as any;
        if (result?.success) return { success: true };
        switch (result?.error) {
            case "INVALID_PIN":
                return { success: false, error: `PIN incorrecto. Intentos restantes: ${result.attempts_left ?? 0}` };
            case "PIN_LOCKED":
                return { success: false, error: "Demasiados intentos incorrectos. Espera unos minutos antes de volver a intentar." };
            case "WEAK_PASSWORD":
                return { success: false, error: "La contraseña no cumple con los requisitos de seguridad." };
            default:
                return { success: false, error: "No se pudo actualizar el acceso web." };
        }
    } catch (error: any) {
        console.error('Error updating web access:', error?.message);
        return { success: false, error: "No se pudo actualizar el acceso web." };
    }
}
