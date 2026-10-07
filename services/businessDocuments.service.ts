import { supabase } from "../lib/supabase";

export type BusinessDocumentStatus = "pending" | "approved" | "rejected";

export interface BusinessDocumentType {
  code: string;
  name: string;
  description: string | null;
  required: boolean;
}

export interface BusinessDocument {
  id: string;
  doc_type: string;
  file_name: string;
  status: BusinessDocumentStatus;
  reason: string | null;
  created_at: string;
}

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string;
  size?: number;
}

/** Formatos y tamaño que acepta el servidor (submit_business_document) */
export const ALLOWED_MIME_TYPES = ["application/pdf", "image/jpeg", "image/png"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

const SUBMIT_ERRORS: Record<string, string> = {
  NOT_BUSINESS: "Solo las cuentas de empresa cargan esta documentación.",
  INVALID_TYPE: "Tipo de documento inválido.",
  INVALID_PATH: "No se pudo registrar el archivo. Intenta de nuevo.",
  FILE_NOT_FOUND: "El archivo no se terminó de subir. Intenta de nuevo.",
  FILE_TOO_LARGE: "El archivo supera los 10 MB.",
  INVALID_FILE: "Solo se aceptan archivos PDF, JPG o PNG.",
  ALREADY_APPROVED: "Este documento ya fue aprobado.",
  UNAUTHORIZED: "Tu sesión expiró. Vuelve a iniciar sesión.",
};

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export const businessDocumentsService = {
  async getDocumentTypes(): Promise<BusinessDocumentType[]> {
    const { data, error } = await supabase
      .from("business_document_types")
      .select("code, name, description, required")
      .eq("is_active", true)
      .order("sort_order");
    if (error) throw error;
    return (data || []) as BusinessDocumentType[];
  },

  /** Documentos vigentes del usuario (sin los reemplazados) */
  async getMyDocuments(): Promise<BusinessDocument[]> {
    const { data, error } = await supabase
      .from("business_documents")
      .select("id, doc_type, file_name, status, reason, created_at")
      .neq("status", "replaced")
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data || []) as BusinessDocument[];
  },

  /** Sube el archivo a la carpeta privada del usuario y lo registra para revisión */
  async upload(userId: string, docType: string, file: PickedFile): Promise<{ success: boolean; error?: string }> {
    if (!ALLOWED_MIME_TYPES.includes(file.mimeType)) {
      return { success: false, error: SUBMIT_ERRORS.INVALID_FILE };
    }
    if (file.size && file.size > MAX_FILE_BYTES) {
      return { success: false, error: SUBMIT_ERRORS.FILE_TOO_LARGE };
    }

    try {
      const response = await fetch(file.uri);
      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > MAX_FILE_BYTES) {
        return { success: false, error: SUBMIT_ERRORS.FILE_TOO_LARGE };
      }

      const path = `kyb/${userId}/${docType}/${Date.now()}.${EXTENSIONS[file.mimeType]}`;
      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(path, arrayBuffer, { contentType: file.mimeType, upsert: false });
      if (uploadError) {
        console.error("Error subiendo documento:", uploadError);
        return { success: false, error: "No se pudo subir el archivo. Revisa tu conexión." };
      }

      const { data, error } = await supabase.rpc("submit_business_document", {
        p_doc_type: docType,
        p_storage_path: path,
        p_file_name: file.name,
      } as any);
      const result = data as any;
      if (error || !result?.success) {
        return { success: false, error: SUBMIT_ERRORS[result?.error] ?? "No se pudo registrar el documento." };
      }
      return { success: true };
    } catch (err) {
      console.error("Error subiendo documento:", err);
      return { success: false, error: "No se pudo subir el archivo. Revisa tu conexión." };
    }
  },
};
