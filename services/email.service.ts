import { supabase } from "../lib/supabase";

export interface NotificationResponse {
  success: boolean;
  error?: string;
}

/**
 * Encola una notificación en Supabase para ser procesada por el worker de correo/push.
 * Utiliza el sistema de colas PGMQ y la Edge Function notification-worker.
 */
export async function sendOtpEmail(
  userId: string,
  otpCode: string,
): Promise<NotificationResponse> {
  try {
    // Llamada al RPC enqueue_notification definido en la base de datos
    // p_notification_type: 'transfer_otp' (el worker está configurado para manejar este código)
    // p_data: objeto con los datos para el template (se usará {{otp}} en el template_message/email_template_html)
    // Tipo 'transfer_otp' — usado para OTPs de transferencias
    const { error } = await supabase.rpc("enqueue_notification", {
      p_user_id: userId,
      p_notification_type: "transfer_otp",
      p_data: { 
        otp: otpCode,
        otp_code: otpCode 
      },
      p_related_transaction_id: null,
    } as any);

    if (error) {
      console.error("[NOTIFICATION] Error al encolar notificación:", error);
      return {
        success: false,
        error: "No se pudo solicitar el código de verificación",
      };
    }

    return { success: true };
  } catch (error: any) {
    console.error("[NOTIFICATION] Error inesperado:", error);
    return {
      success: false,
      error: error.message || "Error al procesar la solicitud",
    };
  }
}

/**
 * Encola un OTP para cambio de PIN.
 * Usa el tipo 'pin_change_otp' con su propio template (sin placeholders de transferencias).
 */
export async function sendPinChangeOtpEmail(
  userId: string,
  otpCode: string,
): Promise<NotificationResponse> {
  try {
    const { error } = await supabase.rpc("enqueue_notification", {
      p_user_id: userId,
      p_notification_type: "pin_change_otp",
      p_data: { 
        otp: otpCode,
        otp_code: otpCode 
      },
      p_related_transaction_id: null,
    } as any);

    if (error) {
      console.error("[NOTIFICATION] Error al encolar OTP de cambio de PIN:", error);

      // FALLBACK: Si falla la cola (ej: 401 Unauthorized), intentar envío directo
      console.log("[NOTIFICATION] Intentando envío directo (fallback)...");
      
      // Necesitamos el email del usuario para el envío directo
      const { data: userData } = await supabase.from('users').select('email, first_name').eq('id', userId).single();
      
      if (userData?.email) {
        const { error: directError } = await supabase.functions.invoke('notification-worker', {
          body: {
            notification_type: "pin_change_otp",
            data: { 
              email: userData.email,
              first_name: userData.first_name || 'Usuario',
              otp: otpCode,
              otp_code: otpCode
            }
          }
        });

        if (!directError) {
          console.log("[NOTIFICATION] Envío directo exitoso");
          return { success: true };
        }
        console.error("[NOTIFICATION] Falló también el envío directo:", directError);
      }

      return {
        success: false,
        error: "No se pudo enviar el código de verificación",
      };
    }

    return { success: true };
  } catch (error: any) {
    console.error("[NOTIFICATION] Error inesperado:", error);
    return {
      success: false,
      error: error.message || "Error al procesar la solicitud",
    };
  }
}

// Mensajes legibles para los errores de las funciones de OTP de registro
const SIGNUP_OTP_ERRORS: Record<string, string> = {
  INVALID_EMAIL: "El email no es válido.",
  EMAIL_IN_USE: "Ya existe una cuenta con ese email. Inicia sesión.",
  TOO_SOON: "Espera un minuto antes de pedir otro código.",
  TOO_MANY_REQUESTS: "Pediste demasiados códigos. Intenta de nuevo más tarde.",
  CODE_EXPIRED: "El código expiró o ya fue usado. Pide uno nuevo.",
  TOO_MANY_ATTEMPTS: "Demasiados intentos fallidos. Pide un código nuevo.",
  INVALID_CODE: "Código incorrecto.",
};

export type SignupOtpErrorCode = keyof typeof SIGNUP_OTP_ERRORS;

export interface SignupOtpResponse extends NotificationResponse {
  /** Código de error del servidor (ej. EMAIL_IN_USE, TOO_SOON) */
  code?: SignupOtpErrorCode;
}

const otpErrorCode = (raw?: string | null): SignupOtpErrorCode | undefined =>
  raw ? (Object.keys(SIGNUP_OTP_ERRORS) as SignupOtpErrorCode[]).find((k) => raw.includes(k)) : undefined;

const otpErrorMessage = (raw?: string | null, fallback = "No se pudo procesar la solicitud.") => {
  const code = otpErrorCode(raw);
  return code ? SIGNUP_OTP_ERRORS[code] : fallback;
};

/**
 * Pide un código de verificación de email antes del registro.
 * El servidor genera el código, guarda su hash y encola el email (no se expone al cliente).
 */
export async function requestSignupEmailCode(
  email: string,
  firstName: string,
): Promise<SignupOtpResponse> {
  try {
    const { error } = await supabase.rpc("request_signup_email_otp", {
      p_email: email,
      p_first_name: firstName,
    } as any);

    if (error) {
      console.error("[NOTIFICATION] Error al pedir código de registro:", error);
      return {
        success: false,
        code: otpErrorCode(error.message),
        error: otpErrorMessage(error.message, "No se pudo enviar el código por correo. Puedes reintentar."),
      };
    }
    return { success: true };
  } catch (error: any) {
    console.error("[NOTIFICATION] Error inesperado en pre-signup:", error);
    return { success: false, error: error.message || "Error al procesar la solicitud" };
  }
}

/**
 * Verifica el código de registro contra el servidor (máximo 5 intentos por código).
 */
export async function verifySignupEmailCode(
  email: string,
  code: string,
): Promise<SignupOtpResponse> {
  try {
    const { data, error } = await supabase.rpc("verify_signup_email_otp", {
      p_email: email,
      p_code: code,
    } as any);

    if (error) {
      console.error("[NOTIFICATION] Error al verificar código de registro:", error);
      return { success: false, error: "No se pudo verificar el código. Revisa tu conexión." };
    }

    const result = data as { success: boolean; error?: string; attempts_left?: number } | null;
    if (result?.success) return { success: true };

    let message = otpErrorMessage(result?.error, "Código incorrecto o expirado.");
    if (result?.error === "INVALID_CODE" && typeof result.attempts_left === "number") {
      message += ` Te quedan ${result.attempts_left} intento${result.attempts_left === 1 ? "" : "s"}.`;
    }
    return { success: false, code: otpErrorCode(result?.error), error: message };
  } catch (error: any) {
    console.error("[NOTIFICATION] Error inesperado verificando código:", error);
    return { success: false, error: error.message || "Error al procesar la solicitud" };
  }
}
