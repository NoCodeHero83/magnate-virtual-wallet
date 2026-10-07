import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { ScreenHeader } from "../../components/layout";
import { Button, AlertDialog } from "../../components/ui";
import { useTheme } from "../../context/ThemeContext";
import { useAuth } from "../../context/AuthContext";
import { spacing, borderRadius } from "../../theme";
import {
  businessDocumentsService,
  BusinessDocument,
  BusinessDocumentType,
  ALLOWED_MIME_TYPES,
} from "../../services/businessDocuments.service";

const STATUS_INFO = {
  pending: { label: "En revisión", icon: "time-outline" as const, color: "warning" },
  approved: { label: "Aprobado", icon: "checkmark-circle" as const, color: "success" },
  rejected: { label: "Rechazado", icon: "close-circle" as const, color: "destructive" },
  missing: { label: "Falta subir", icon: "cloud-upload-outline" as const, color: "mutedForeground" },
} as const;

const createStyles = (colors: any) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    content: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xl * 2 },
    intro: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20 },
    card: {
      padding: spacing.md,
      backgroundColor: colors.card,
      borderRadius: borderRadius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      gap: spacing.sm,
    },
    cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
    docName: { fontSize: 16, fontWeight: "600", color: colors.foreground },
    optional: { fontSize: 12, color: colors.mutedForeground, fontWeight: "400" },
    description: { fontSize: 13, color: colors.mutedForeground, marginTop: 2 },
    statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
    statusText: { fontSize: 13, fontWeight: "600" },
    fileName: { fontSize: 12, color: colors.mutedForeground, flexShrink: 1 },
    reasonBox: {
      backgroundColor: "rgba(239, 68, 68, 0.08)",
      borderRadius: borderRadius.md,
      padding: spacing.sm,
    },
    reasonText: { fontSize: 13, color: colors.destructive },
    uploadButton: { height: 44, flexDirection: "row", alignItems: "center", justifyContent: "center" },
    center: { padding: spacing.xl, alignItems: "center", gap: spacing.md },
  });

export default function CompanyDocumentsScreen() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [types, setTypes] = useState<BusinessDocumentType[]>([]);
  const [documents, setDocuments] = useState<BusinessDocument[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingType, setUploadingType] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ visible: boolean; title: string; description: string; variant?: "default" | "destructive" }>({
    visible: false,
    title: "",
    description: "",
  });

  const load = useCallback(async () => {
    try {
      const [docTypes, docs] = await Promise.all([
        businessDocumentsService.getDocumentTypes(),
        businessDocumentsService.getMyDocuments(),
      ]);
      setTypes(docTypes);
      setDocuments(docs);
      setLoadError(false);
    } catch (error) {
      console.error("Error cargando documentación:", error);
      setLoadError(true);
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleUpload = async (docType: BusinessDocumentType) => {
    if (!user?.id || uploadingType) return;
    const picked = await DocumentPicker.getDocumentAsync({
      type: ALLOWED_MIME_TYPES,
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (picked.canceled || !picked.assets?.[0]) return;
    const asset = picked.assets[0];

    setUploadingType(docType.code);
    const result = await businessDocumentsService.upload(user.id, docType.code, {
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType ?? "",
      size: asset.size,
    });
    setUploadingType(null);

    if (result.success) {
      setAlert({ visible: true, title: "Documento enviado", description: `Recibimos "${docType.name}". Lo vamos a revisar y te avisaremos si hace falta algo más.` });
      load();
    } else {
      setAlert({ visible: true, title: "No se pudo subir", description: result.error ?? "Intenta de nuevo.", variant: "destructive" });
    }
  };

  if (user?.account_type !== "business") {
    return (
      <SafeAreaView style={styles.container} edges={["top"]}>
        <ScreenHeader title="Documentación" showBackButton={true} />
        <View style={styles.center}>
          <Text style={{ color: colors.mutedForeground }}>Esta sección es solo para cuentas de empresa.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const missingRequired = types.filter(
    (t) => t.required && !documents.some((d) => d.doc_type === t.code && d.status !== "rejected")
  ).length;

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <ScreenHeader title="Documentación de la empresa" showBackButton={true} />

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : loadError ? (
        <View style={styles.center}>
          <Text style={{ color: colors.mutedForeground, textAlign: "center" }}>
            No pudimos cargar la documentación. Revisa tu conexión.
          </Text>
          <Button variant="outline" onPress={() => { setIsLoading(true); load(); }}>
            Reintentar
          </Button>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />}
        >
          <Text style={styles.intro}>
            {missingRequired > 0
              ? `Sube los documentos de tu empresa para que podamos revisar la cuenta. Te faltan ${missingRequired} obligatorios.`
              : "Ya enviaste los documentos obligatorios. Te avisaremos si hace falta corregir alguno."}
            {"\n"}Formatos: PDF, JPG o PNG, hasta 10 MB.
          </Text>

          {types.map((type) => {
            const doc = documents.find((d) => d.doc_type === type.code);
            const statusKey = doc ? doc.status : "missing";
            const info = STATUS_INFO[statusKey];
            const canUpload = !doc || doc.status === "rejected" || doc.status === "pending";
            const isUploading = uploadingType === type.code;

            return (
              <View key={type.code} style={styles.card}>
                <View style={styles.cardHeader}>
                  <Ionicons name="document-text-outline" size={22} color={colors.foreground} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.docName}>
                      {type.name}
                      {!type.required && <Text style={styles.optional}>  (opcional)</Text>}
                    </Text>
                    {type.description ? <Text style={styles.description}>{type.description}</Text> : null}
                  </View>
                </View>

                <View style={styles.statusRow}>
                  <Ionicons name={info.icon} size={16} color={colors[info.color]} />
                  <Text style={[styles.statusText, { color: colors[info.color] }]}>{info.label}</Text>
                  {doc && <Text style={styles.fileName} numberOfLines={1}>· {doc.file_name}</Text>}
                </View>

                {doc?.status === "rejected" && doc.reason ? (
                  <View style={styles.reasonBox}>
                    <Text style={styles.reasonText}>Motivo: {doc.reason}</Text>
                  </View>
                ) : null}

                {canUpload && (
                  <Button
                    variant={doc ? "outline" : "primary"}
                    onPress={() => handleUpload(type)}
                    loading={isUploading}
                    disabled={!!uploadingType && !isUploading}
                    style={styles.uploadButton}
                  >
                    {doc ? "Subir otra versión" : "Subir documento"}
                  </Button>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      <AlertDialog
        visible={alert.visible}
        title={alert.title}
        description={alert.description}
        variant={alert.variant}
        confirmLabel="Entendido"
        onConfirm={() => setAlert((prev) => ({ ...prev, visible: false }))}
        onClose={() => setAlert((prev) => ({ ...prev, visible: false }))}
      />
    </SafeAreaView>
  );
}
