// ZapSign se consulta desde el servidor (edge function "zapsign"): la app no tiene la API key.
// El entorno (sandbox / producción) y si la verificación se simula se configuran en
// Supabase, en app_settings (app_environment e identity_verification_mode).
import { supabase } from '../lib/supabase';

export interface CreateDocumentResult {
    success: boolean;
    signUrl?: string;
    docToken?: string;
    /** Verificación simulada (solo en desarrollo): no hay nada que firmar */
    simulated?: boolean;
    error?: string;
}

export interface GetSignedUrlResult {
    success: boolean;
    signedFileUrl?: string | null;
    status?: string;
    error?: string;
}

export interface GetSignerUrlResult {
    success: boolean;
    signUrl?: string;
    error?: string;
}

export interface ZapSignValidationItem {
    type: string;
    status: string; // 'success' | 'failed' | ...
    reason?: string;
    created_at?: string;
    document_ocr?: {
        name?: string;
        last_name?: string;
        document_type?: string;
        document_number?: string;
        date_of_birth?: string;
        document_country?: string;
    } | null;
}

export interface ZapSignBiometric {
    selfieValidationType?: string | null;
    valid: boolean;
    simulated?: boolean;
    validations?: ZapSignValidationItem[];
    extractedName?: string;
    documentNumber?: string;
    reason?: string;
}

export interface ZapSignIdentityResult {
    signed: boolean;
    verified: boolean;
    strict: boolean;
    signedFileUrl?: string | null;
    biometric?: ZapSignBiometric;
    error?: string;
}

/** Llama a la edge function; los errores 4xx/5xx también traen cuerpo JSON */
async function callZapSign(body: Record<string, unknown>): Promise<any> {
    const { data, error } = await supabase.functions.invoke('zapsign', { body });
    if (!error) return data;
    try {
        const parsed = await (error as any)?.context?.json?.();
        if (parsed) return parsed;
    } catch {
        // sin cuerpo
    }
    return { success: false, error: 'Error de red con el servicio de verificación' };
}

/**
 * Crea el documento que el usuario firma durante el registro.
 * Con la verificación simulada (desarrollo) devuelve `simulated: true` y no hay firma.
 */
export async function createZapSignDocument(userName: string, userEmail: string): Promise<CreateDocumentResult> {
    const res = await callZapSign({ action: 'create', name: userName, email: userEmail });
    if (!res?.success || !res.docToken) {
        return { success: false, error: res?.error || 'Error al crear el contrato' };
    }
    return { success: true, docToken: res.docToken, signUrl: res.signUrl ?? undefined, simulated: !!res.simulated };
}

/** URL de firma del documento */
export async function getSignerUrl(docToken: string): Promise<GetSignerUrlResult> {
    const res = await callZapSign({ action: 'status', docToken });
    if (!res?.success || !res.signUrl) {
        return { success: false, error: res?.error || 'No se pudo obtener la URL de firma' };
    }
    return { success: true, signUrl: res.signUrl };
}

/**
 * Estado del documento y URL del contrato firmado (`signedFileUrl` es null mientras no se firme;
 * la URL expira en ~60 minutos).
 */
export async function getSignedDocumentUrl(docToken: string): Promise<GetSignedUrlResult> {
    const res = await callZapSign({ action: 'status', docToken });
    if (!res?.success) return { success: false, error: res?.error || 'Error al consultar el documento' };
    return { success: true, signedFileUrl: res.signedFileUrl ?? null, status: res.status };
}

/**
 * Verifica la identidad tras la firma. El servidor decide si es estricta (producción con
 * validación biométrica configurada) y deja el resultado registrado para el alta de la cuenta.
 */
export async function verifyZapSignIdentity(docToken: string): Promise<ZapSignIdentityResult> {
    const res = await callZapSign({ action: 'verify', docToken });
    return {
        signed: !!res?.signed,
        verified: !!res?.verified,
        strict: !!res?.strict,
        signedFileUrl: res?.signedFileUrl ?? null,
        biometric: res?.biometric,
        error: res?.error,
    };
}
