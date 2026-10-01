import { supabase } from "../lib/supabase";
import bcrypt from "bcryptjs";
import * as Crypto from "expo-crypto";

// Polyfill for random bytes in React Native for bcryptjs
bcrypt.setRandomFallback((len) => {
  const randomBytes = Crypto.getRandomBytes(len);
  return Array.from(randomBytes);
});

import { encrypt, decrypt, generateSecurePassword } from "../utils/crypto";
import { sendOtpEmail } from "./email.service";
import { incrementPinAttempts, resetPinAttempts } from "./storage.service";
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

// Global state for manual OTP (Resend flow)
let tempOtp: { code: string; email: string; expires: number } | null = null;

export interface AuthResult {
  success: boolean;
  error?: string;
  userId?: string;
  requireDeviceVerification?: boolean;
}
// Tipo para el resultado del RPC get_user_login_data
export interface LoginUserData {
  id: string;
  email: string;
  pin_hash: string;
  verification_status: VerificationStatus;
  auto_password_encrypted: string | null;
  account_type?: UserAccountType;
  status_reason?: string | null;
}

// Cuenta de prueba de Play Store — siempre bypassa verificación de dispositivo
const TEST_ACCOUNT_EMAIL = 'oscarmijaelpg@gmail.com';
/**
 * Login con email + PIN
 */
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
 * Indica si el dispositivo actual es conocido para el usuario.
 * La cuenta de prueba de Play Store siempre retorna true (bypass).
 */
export async function isDeviceKnown(userId: string, email: string): Promise<boolean> {
  if (email.toLowerCase().trim() === TEST_ACCOUNT_EMAIL) {
    return true;
  }

  const deviceId = await getLocalDeviceId();

  try {
    const { data, error } = await supabase
      .from("user_devices")
      .select("id")
      .eq("user_id", userId)
      .eq("device_id", deviceId)
      .eq("status", "active")
      .limit(1);

    if (error || !data || data.length === 0) {
      if (error) console.error("isDeviceKnown error:", error);
      return false; // Not found or error
    }
    
    // Update last_active_at implicitly when checked
    await (supabase.from("user_devices") as any).update({ last_active_at: new Date().toISOString() }).eq("id", (data as any)[0].id);

    return true;
  } catch (err) {
    console.error("Error verifying known device:", err);
    return false;
  }
}

/**
 * Registra el dispositivo actual como confiable tras éxito de OTP.
 */
export async function registerCurrentDevice(): Promise<AuthResult> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Usuario no autenticado." };

    const deviceId = await getLocalDeviceId();
    
    // Check if it exists but revoked
    const { data: existing } = await supabase
      .from("user_devices")
      .select("id")
      .eq("user_id", user.id)
      .eq("device_id", deviceId)
      .limit(1);

    if (existing && existing.length > 0) {
      const { error } = await (supabase.from("user_devices") as any).update({ 
        status: "active", 
        revoked_at: null,
        last_active_at: new Date().toISOString() 
      }).eq("id", (existing as any)[0].id);
      
      if (error) throw error;
      return { success: true };
    }

    // Insert new
    const { error: insertError } = await supabase.from("user_devices").insert({
      user_id: user.id,
      device_id: deviceId,
      device_name: Device.deviceName || 'Dispositivo desconocido',
      device_model: Device.modelName || 'Modelo desconocido',
      platform: Platform.OS as 'ios' | 'android' | 'web',
      os_version: Device.osVersion || null,
      app_version: null, // we can inject APP_VERSION easily if needed but not strictly necessary for backend
      status: "active",
      is_primary: false,
      biometric_enabled: false,
      last_active_at: new Date().toISOString(),
    } as any);

    if (insertError) throw insertError;
    return { success: true };
  } catch (error: any) {
    console.error("Error registering device:", error);
    return { success: false, error: "No se pudo registrar el dispositivo." };
  }
}

export async function loginWithPin(
  email: string,
  pin: string,
): Promise<AuthResult> {
  try {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Usar RPC para buscar datos saltando RLS
    const { data: userData, error: userError } = await supabase.rpc(
      "get_user_login_data",
      { email_input: normalizedEmail } as any,
    );

    if (userError) {
      return { success: false, error: "Error de conexión" };
    }

    // RPC retorna un array, tomamos el primero y lo tipamos
    const user = userData?.[0] as LoginUserData | undefined;
    if (!user) {
      return { success: false, error: "Usuario no encontrado" };
    }

    // 2. Verificar PIN con bcrypt
    if (!user.pin_hash) {
      return { success: false, error: "Datos de seguridad corruptos" };
    }

    const pinValid = await bcrypt.compare(pin, user.pin_hash);
    if (!pinValid) {
      const attempts = await incrementPinAttempts(normalizedEmail);
      if (attempts >= 3) {
        await suspendUserAccount(user.id);
        return {
          success: false,
          error: "Has excedido el número de intentos. Cuenta suspendida.",
        };
      }
      return {
        success: false,
        error: `PIN incorrecto. Intentos restantes: ${3 - attempts}`,
      };
    }

    // PIN correcto, resetear intentos
    await resetPinAttempts(normalizedEmail);

    // 4. Verificar status
    if (user.verification_status === "suspended") {
      return { success: false, error: "Esta cuenta se encuentra suspendida." };
    }

    if (user.verification_status === "rejected") {
      const reason = user.status_reason ? `\nMotivo: ${user.status_reason}` : "";
      return {
        success: false,
        error: `Tu solicitud de cuenta fue rechazada.${reason}\nSi crees que es un error, contacta a soporte.`,
      };
    }

    // "pending": puede ingresar, pero no operar hasta que un administrador apruebe la cuenta
    if (user.verification_status !== "verified" && user.verification_status !== "pending") {
      return { success: false, error: "Cuenta pendiente de verificación" };
    }

    // 5. Desencriptar la contraseña
    if (!user.auto_password_encrypted) {
      return { success: false, error: "Error interno: Credenciales inválidas" };
    }

    const autoPassword = await decrypt(user.auto_password_encrypted);

    // 6. Hacer login con Supabase Auth (Must login first to bypass Row Level Security restrictions for the device check)
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password: autoPassword,
    });

    if (signInError) {
      return { success: false, error: "Error al iniciar sesión" };
    }

    // 7. Verificar dispositivo (la cuenta de prueba siempre lo bypassa)
    const deviceKnown = await isDeviceKnown(user.id, normalizedEmail);

    if (!deviceKnown) {
      // Send OTP implicitly since we are now logged in
      await sendVerificationOtp();
      return { success: true, userId: user.id, requireDeviceVerification: true };
    }

    return { success: true, userId: user.id, requireDeviceVerification: false };
  } catch (error: any) {
    return { success: false, error: error.message || "Error desconocido" };
  }
}

/**
 * Suspender cuenta de usuario
 */
export async function suspendUserAccount(userId: string): Promise<AuthResult> {
  try {
    const { error } = await supabase.rpc("suspend_user_account", {
      p_user_id: userId,
    } as any);

    if (error) throw error;
    return { success: true };
  } catch (error: any) {
    console.error("[AUTH] Error suspending account:", error);
    return { success: false, error: "No se pudo suspender la cuenta" };
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

    return {
      success: true,
      userId,
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

/**
 * Verify PIN for sensitive actions using bcrypt.
 * Fetches the stored pin_hash from the DB and compares with bcrypt.
 */
export async function verifyPin(pin: string): Promise<boolean> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return false;

    const { data, error } = await (supabase.from('users') as any)
      .select('pin_hash')
      .eq('id', user.id)
      .single();

    if (error || !data?.pin_hash) {
      console.error('[AUTH] Error fetching pin_hash:', error);
      return false;
    }

    return await bcrypt.compare(pin, data.pin_hash);
  } catch (error) {
    console.error('[AUTH] Error verifying PIN:', error);
    return false;
  }
}

/**
 * Send OTP using Resend instead of Supabase
 */
export async function sendVerificationOtp(): Promise<AuthResult> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user || !user.email)
      return { success: false, error: "Usuario no autenticado" };

    // 1. Generar código de 6 dígitos
    const code = Math.floor(100000 + Math.random() * 900000).toString();

    // 2. Guardar temporalmente para verificación (10 minutos exp)
    tempOtp = {
      code,
      email: user.email,
      expires: Date.now() + 10 * 60 * 1000,
    };

    // 3. Enviar notificación (se encargará el worker de Supabase)
    const res = await sendOtpEmail(user.id, code);

    if (!res.success) throw new Error(res.error);

    return { success: true };
  } catch (error: any) {
    console.error("[AUTH] Error al solicitar OTP:", error);
    return {
      success: false,
      error: error.message || "Error al enviar el código de verificación",
    };
  }
}

/**
 * Verify the manual OTP code
 */
export async function verifyVerificationOtp(
  token: string,
): Promise<AuthResult> {
  try {
    if (!tempOtp) {
      return { success: false, error: "No hay un código pendiente" };
    }

    if (Date.now() > tempOtp.expires) {
      tempOtp = null;
      return { success: false, error: "El código ha expirado" };
    }

    if (tempOtp.code !== token) {
      return { success: false, error: "Código incorrecto" };
    }

    // Código válido, limpiar
    tempOtp = null;
    return { success: true };
  } catch (error: any) {
    return { success: false, error: "Error al verificar el código" };
  }
}

/**
 * Update user PIN after security verification (PIN + OTP)
 */
export async function updatePin(newPin: string): Promise<AuthResult> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { success: false, error: "Usuario no autenticado" };

    // 1. Hash new PIN
    const salt = await bcrypt.genSalt(10);
    const newPinHash = await bcrypt.hash(newPin, salt);

    // 2. Update in DB
    const { error: updateError } = await (supabase.from("users") as any)
      .update({ pin_hash: newPinHash })
      .eq("id", user.id);

    if (updateError) {
      console.error("[AUTH] Error updating pin_hash in DB:", updateError);
      return { success: false, error: "Error al actualizar el PIN" };
    }

    // 3. Update Auth Metadata
    await supabase.auth.updateUser({
      data: { pin_hash: newPinHash },
    });

    return { success: true };
  } catch (error: any) {
    console.error("[AUTH] updatePin unexpected error:", error);
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

    const { error } = await (supabase.from("user_devices") as any).update({
      status: "revoked",
      revoked_at: new Date().toISOString(),
      revoke_reason: "User revoked manually"
    }).eq("id", deviceId).eq("user_id", user.id);

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
    .select("*")
    .eq("id", userId)
    .single();

  return { user: data as unknown as User | null, error: error?.message };
}

/**
 * Actualiza la configuración de Acceso Web
 */
export async function updateWebAccess(userId: string, enabled: boolean, password?: string): Promise<{ success: boolean; error?: string }> {
    try {
        const updates: any = {
            web_access_enabled: enabled,
            updated_at: new Date().toISOString(),
        };

        if (enabled && password) {
             const salt = await bcrypt.genSalt(10);
             const hash = await bcrypt.hash(password, salt);
             updates.web_password_hash = hash;
             updates.web_access_enabled_at = new Date().toISOString();
        }

        const { error } = await supabase
            .from('users')
            .update(updates)
            .eq('id', userId);

        if (error) throw error;

        return { success: true };
    } catch (error: any) {
        console.error('Error updating web access:', error);
        return { success: false, error: error.message };
    }
}
