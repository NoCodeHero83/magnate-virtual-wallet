import { ZAPSIGN_CONFIG, isProductionEnv } from '../config/environment';

export interface ZapSignDocument {
    token: string;
    status: string;
    original_file: string;
    signed_file: string | null;
    signers: Array<{
        token: string;
        sign_url: string;
        status: string;
        signed_at: string | null;
    }>;
}

export interface CreateDocumentResult {
    success: boolean;
    signUrl?: string;
    docToken?: string;
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

/**
 * Crea un documento en ZapSign para que el usuario lo firme durante el registro.
 */
export async function createZapSignDocument(
    userName: string,
    userEmail: string,
): Promise<CreateDocumentResult> {
    const name = (userName || '').trim();
    const email = (userEmail || '').trim().toLowerCase();
    console.log('[ZapSign] Enviando request a:', `${ZAPSIGN_CONFIG.baseUrl}/api/v1/models/create-doc/`);
    console.log('[ZapSign] Token cargado por Expo:', `***${ZAPSIGN_CONFIG.apiKey.slice(-4)}`);
    console.log('[ZapSign] Template ID:', ZAPSIGN_CONFIG.templateId);
    
    if (!ZAPSIGN_CONFIG.apiKey || !ZAPSIGN_CONFIG.templateId) {
        console.error('[ZapSign] CRÍTICO: La API key o el Template ID están vacíos. Revisa el archivo .env');
    }

    try {
        const payload = {
            template_id: ZAPSIGN_CONFIG.templateId,
            signer_name: name,
            send_automatic_email: false,
            signers: [
                {
                    name,
                    email,
                    auth_mode: 'assinaturaTela',
                    send_automatic_email: true,
                    // En sandbox y producción exigimos documento; selfie sólo en producción
                    require_selfie_photo: isProductionEnv,
                    require_document_photo: true,
                    // Matching biométrico real sólo si se configuró el tipo (producción + créditos)
                    ...(ZAPSIGN_CONFIG.selfieValidationType
                        ? { selfie_validation_type: ZAPSIGN_CONFIG.selfieValidationType }
                        : {}),
                }
            ],
            data: [
                { de: '{{Nombre}}', para: name },
                { de: '{{Email}}', para: email }
            ]
        };

        const response = await fetch(`${ZAPSIGN_CONFIG.baseUrl}/api/v1/models/create-doc/`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ZAPSIGN_CONFIG.apiKey.trim()}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const errorText = await response.text();
            let errorData: any = {};
            try { errorData = JSON.parse(errorText); } catch(e) {}
            
            console.error('[ZapSign] Payload enviado:', JSON.stringify(payload));
            console.error('[ZapSign] Respuesta cruda (HTTP '+response.status+'):', errorText);
            
            const errMsg = errorData.detail || errorData.error || `Error HTTP ${response.status} al crear documento en ZapSign`;
            return { success: false, error: errMsg };
        }

        const data: ZapSignDocument = await response.json();
        const signer = data.signers?.[0];

        const signUrl = signer?.sign_url || `https://app.zapsign.com.br/verificar/${signer?.token}`;

        return {
            success: true,
            signUrl,
            docToken: data.token,
        };
    } catch (error: any) {
        console.error('[ZapSign] Error inesperado al crear documento:', error);
        return { success: false, error: error.message || 'Error de red con ZapSign' };
    }
}

/**
 * Obtiene la URL de firma del primer firmante dado el token del documento.
 */
export async function getSignerUrl(docToken: string): Promise<GetSignerUrlResult> {
    try {
        const response = await fetch(`${ZAPSIGN_CONFIG.baseUrl}/api/v1/docs/${docToken}/`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${ZAPSIGN_CONFIG.apiKey.trim()}`,
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: errorText || `HTTP ${response.status}` };
        }

        const data: ZapSignDocument = await response.json();
        const signer = data.signers?.[0];
        const signUrl = signer?.sign_url || (signer?.token ? `https://app.zapsign.com.br/verificar/${signer.token}` : undefined);

        if (!signUrl) {
            return { success: false, error: 'No se pudo obtener sign_url del documento' };
        }
        return { success: true, signUrl };
    } catch (e: any) {
        return { success: false, error: e.message || 'Error al consultar sign_url' };
    }
}

/**
 * Obtiene la URL del documento firmado dado el token del documento.
 * `signed_file` es null mientras el usuario no haya completado la firma.
 * Las URLs expiran en ~60 minutos.
 */
export async function getSignedDocumentUrl(
    docToken: string,
): Promise<GetSignedUrlResult> {
    try {
        const response = await fetch(`${ZAPSIGN_CONFIG.baseUrl}/api/v1/docs/${docToken}/`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${ZAPSIGN_CONFIG.apiKey.trim()}`,
            },
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errMsg = (errorData as any).detail || `Error HTTP ${response.status} al consultar documento`;
            return { success: false, error: errMsg };
        }

        const data: ZapSignDocument = await response.json();

        return {
            success: true,
            signedFileUrl: data.signed_file || null,
            status: data.status,
        };
    } catch (error: any) {
        console.error('[ZapSign] Error al consultar documento:', error);
        return { success: false, error: error.message || 'Error de red con ZapSign' };
    }
}

/**
 * Obtiene la URL del contrato firmado con reintentos.
 * ZapSign Sandbox puede tardar unos segundos en generar el PDF después de la firma.
 */
export async function getSignedDocumentUrlWithRetry(
    docToken: string,
    maxRetries: number = 3,
    delayMs: number = 2000,
): Promise<string | null> {
    for (let i = 0; i < maxRetries; i++) {
        const result = await getSignedDocumentUrl(docToken);
        if (result.success && result.signedFileUrl) {
            return result.signedFileUrl;
        }
        if (i < maxRetries - 1) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    return null;
}

/* ------------------------------------------------------------------ */
/* Verificación biométrica del firmante (Consultar validações)         */
/* ------------------------------------------------------------------ */

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

export interface GetSignerValidationResult {
    success: boolean;
    validations?: ZapSignValidationItem[];
    selfieValidationType?: string | null;
    error?: string;
}

export interface ZapSignBiometric {
    selfieValidationType?: string | null;
    valid: boolean;
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

/**
 * Devuelve el detalle del documento, incluyendo el token del primer firmante.
 */
async function getDocumentDetail(docToken: string): Promise<{
    success: boolean;
    status?: string;
    signedFile?: string | null;
    signerToken?: string | null;
    error?: string;
}> {
    try {
        const response = await fetch(`${ZAPSIGN_CONFIG.baseUrl}/api/v1/docs/${docToken}/`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${ZAPSIGN_CONFIG.apiKey.trim()}` },
        });
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: errorText || `HTTP ${response.status}` };
        }
        const data: ZapSignDocument = await response.json();
        return {
            success: true,
            status: data.status,
            signedFile: data.signed_file,
            signerToken: data.signers?.[0]?.token || null,
        };
    } catch (e: any) {
        return { success: false, error: e.message || 'Error al consultar documento' };
    }
}

/**
 * Consulta las validaciones de identidad del firmante.
 * Endpoint: GET /api/v1/signer-verification-details/{signer_token}/
 */
export async function getSignerValidation(signerToken: string): Promise<GetSignerValidationResult> {
    try {
        const response = await fetch(
            `${ZAPSIGN_CONFIG.baseUrl}/api/v1/signer-verification-details/${signerToken}/`,
            {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${ZAPSIGN_CONFIG.apiKey.trim()}` },
            },
        );
        if (!response.ok) {
            const errorText = await response.text();
            return { success: false, error: errorText || `HTTP ${response.status}` };
        }
        const data = await response.json();
        return {
            success: true,
            validations: data.validations || [],
            selfieValidationType: data.selfie_validation_type || null,
        };
    } catch (e: any) {
        return { success: false, error: e.message || 'Error al consultar validaciones' };
    }
}

/**
 * Verifica la identidad del usuario tras la firma del contrato.
 *
 * - `signed`: el contrato fue firmado (status === 'assinado' o signed_file presente).
 * - `verified`: en modo estricto (producción + selfie_validation_type configurado) requiere
 *   que TODAS las validaciones del firmante hayan pasado. En sandbox/test siempre es true
 *   (ZapSign sólo captura la selfie/documento, no hace matching real), para no romper el demo.
 */
export async function verifyZapSignIdentity(
    docToken: string,
    strict: boolean = isProductionEnv && !!ZAPSIGN_CONFIG.selfieValidationType,
): Promise<ZapSignIdentityResult> {
    const detail = await getDocumentDetail(docToken);
    if (!detail.success) {
        return { signed: false, verified: false, strict, error: detail.error };
    }

    const signed = detail.status === 'assinado' || !!detail.signedFile;
    if (!signed) {
        return { signed: false, verified: false, strict, error: 'Documento aún no firmado' };
    }

    const validation = await getSignerValidation(detail.signerToken || '');
    const validations = validation.success ? (validation.validations || []) : [];
    const ocr = validations.find(v => v.document_ocr)?.document_ocr;
    const biometric: ZapSignBiometric = {
        selfieValidationType: validation.success ? validation.selfieValidationType : null,
        valid: false,
        validations,
        extractedName: ocr ? `${ocr.name || ''} ${ocr.last_name || ''}`.trim() : undefined,
        documentNumber: ocr?.document_number,
    };

    if (!validation.success) {
        // No pudimos consultar las validaciones.
        if (strict) {
            biometric.reason = 'no_validation_data';
            return { signed: true, verified: false, strict, signedFileUrl: detail.signedFile, biometric };
        }
        biometric.reason = 'validation_unavailable';
        return { signed: true, verified: true, strict, signedFileUrl: detail.signedFile, biometric };
    }

    const allPassed = validations.length > 0 && validations.every(v => v.status === null || v.status === 'success');
    biometric.valid = allPassed;

    if (strict) {
        if (!allPassed) {
            biometric.reason = 'biometric_failed';
            return { signed: true, verified: false, strict, signedFileUrl: detail.signedFile, biometric };
        }
        return { signed: true, verified: true, strict, signedFileUrl: detail.signedFile, biometric };
    }

    // No estricto (sandbox/test): el demo pasa con el contrato firmado.
    return { signed: true, verified: true, strict, signedFileUrl: detail.signedFile, biometric };
}
