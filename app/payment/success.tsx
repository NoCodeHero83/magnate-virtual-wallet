import React, { useRef, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  Share,
  Platform,
  BackHandler,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import ViewShot from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import { Toast } from "../../components/ui";
import {
  colors,
  spacing,
  typography,
  borderRadius,
  shadows,
} from "../../theme";
import { formatCurrency } from "../../utils/formatters";
import { Button } from "../../components/ui";

export default function SuccessScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const amount = typeof params.amount === "string" ? params.amount : "0";
  const recipientName =
    typeof params.recipientName === "string"
      ? params.recipientName
      : "Desconocido";
  // Comisión cobrada (si hubo)
  const commission = Number(typeof params.commission === "string" ? params.commission : 0) || 0;
  const totalDebit = Number(typeof params.totalDebit === "string" ? params.totalDebit : 0) || 0;
  const amountSent = Number(typeof params.amountSent === "string" ? params.amountSent : 0) || 0;
  const reference_number =
    typeof params.reference_number === "string"
      ? params.reference_number
      : `Confirmando el numero de transacción`;
  const date = new Date();

  const viewShotRef = useRef<any>(null);
  const [isDownloading, setIsDownloading] = React.useState(false);
  const [toast, setToast] = React.useState<{
    visible: boolean;
    message: string;
    type: "success" | "error";
  }>({ visible: false, message: "", type: "success" });

  const scaleAnim = useRef(new Animated.Value(0)).current;
  const navigation = useNavigation();

  useEffect(() => {
    // 1. Animación inicial
    Animated.spring(scaleAnim, {
      toValue: 1,
      friction: 6,
      tension: 40,
      useNativeDriver: true,
    }).start();

    // 2. Bloquear botón atrás físico (Android)
    const backAction = () => {
      handleHome();
      return true;
    };

    const backHandler = BackHandler.addEventListener(
      "hardwareBackPress",
      backAction,
    );

    // 3. Bloquear gestos y otros intentos de navegación (iOS/Android)
    const unsubscribe = navigation.addListener("beforeRemove", (e) => {
      // Si el usuario está intentando ir atrás (pop)
      if (e.data.action.type === "POP" || e.data.action.type === "GO_BACK") {
        e.preventDefault();
        handleHome();
      }
    });

    return () => {
      backHandler.remove();
      unsubscribe();
    };
  }, []);



  const handleHome = () => {
    router.dismissAll();
    router.replace("/(tabs)");
  };

  const handleDownload = async () => {
    try {
      setIsDownloading(true);

      // Captured URI
      const uri = await viewShotRef.current.capture();

      // Comparte el comprobante como archivo imagen
      // Esto abrirá el menú nativo para guardarlo, enviarlo o compartirlo.
      await Sharing.shareAsync(uri, {
        mimeType: "image/png",
        dialogTitle: "Guardar Comprobante",
      });
      
    } catch (error) {
      console.error("[SUCCESS] Error downloading receipt:", error);
      setToast({
        visible: true,
        message: "Ocurrió un error al guardar o compartir",
        type: "error",
      });
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <SafeAreaView edges={["top"]}>
          <View style={styles.headerContent}>
            <Animated.View
              style={[
                styles.successIconBubble,
                { transform: [{ scale: scaleAnim }] },
              ]}
            >
              <Ionicons name="checkmark" size={32} color="white" />
            </Animated.View>
            <Text style={styles.headerTitle}>¡Pago Realizado!</Text>
            <Text style={styles.headerSubtitle}>
              Tu transacción fue procesada correctamente
            </Text>
          </View>
        </SafeAreaView>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom + 24, 24) }]}
        showsVerticalScrollIndicator={false}
      >
        {/* Area to Capture */}
        <ViewShot
          ref={viewShotRef}
          options={{
            format: "png", // Usamos PNG para mejor calidad y soporte de bordes
            quality: 1,
            result: "tmpfile",
          }}
        >
          <View style={styles.captureAreaPrimary}>
            {/* Branding en el comprobante */}
            <View style={styles.captureHeader}>
              <View style={styles.miniLogo}>
                <Ionicons name="diamond" size={16} color="white" />
              </View>
              <Text style={styles.captureBrand}>MAGNATE</Text>
            </View>

            <View style={styles.cardCapture}>
              <View style={styles.amountSection}>
                <Text style={styles.label}>Monto pagado</Text>
                <Text style={styles.amountValue}>$ {amount}</Text>
              </View>

              <View style={styles.dashedDivider} />

              <View style={styles.detailsSection}>
                <View style={styles.row}>
                  <View style={styles.iconBox}>
                    <Ionicons name="business" size={20} color={colors.accent} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Destinatario</Text>
                    <Text style={styles.value}>{recipientName}</Text>
                  </View>
                </View>

                {commission > 0 && (
                  <>
                    <View style={styles.divider} />
                    <View style={styles.metaRow}>
                      <Text style={styles.label}>Enviado</Text>
                      <Text style={styles.metaValue}>{formatCurrency(amountSent)}</Text>
                    </View>
                    <View style={[styles.metaRow, { marginTop: spacing.sm }]}>
                      <Text style={styles.label}>Comisión</Text>
                      <Text style={styles.metaValue}>{formatCurrency(commission)}</Text>
                    </View>
                    <View style={[styles.metaRow, { marginTop: spacing.sm }]}>
                      <Text style={styles.label}>Total debitado</Text>
                      <Text style={styles.metaValue}>{formatCurrency(totalDebit)}</Text>
                    </View>
                  </>
                )}

                <View style={styles.divider} />

                <View style={styles.metaRow}>
                  <View>
                    <Text style={styles.label}>Fecha</Text>
                    <Text style={styles.metaValue}>
                      {date.toLocaleDateString()}
                    </Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={styles.label}>Hora</Text>
                    <Text style={styles.metaValue}>
                      {date.toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </Text>
                  </View>
                </View>

                <View style={styles.divider} />

                <View>
                  <Text style={styles.label}>ID de Transacción</Text>
                  <Text style={styles.idValue}>{reference_number}</Text>
                </View>
              </View>

              {/* Watermark/Footer en el capture */}
              <View style={styles.captureFooter}>
                <Text style={styles.captureFooterText}>
                  Comprobante oficial Magnate Financial Freedom
                </Text>
              </View>
            </View>
          </View>
        </ViewShot>

        {/* Actions */}
        <View style={styles.actions}>
          <Button
            variant="outline"
            onPress={handleDownload}
            style={styles.homeButton}
            loading={isDownloading}
          >
            {!isDownloading && (
              <Ionicons
                name="share-social-outline"
                size={20}
                color={colors.accent}
                style={{ marginRight: 8 }}
              />
            )}
            <Text style={{ color: colors.accent, fontWeight: "600" }}>
              Compartir
            </Text>
          </Button>

          <Button
            variant="primary"
            onPress={handleHome}
            style={styles.homeButton}
          >
            Ir al Inicio
          </Button>
        </View>
      </ScrollView>

      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onHide={() => setToast((prev) => ({ ...prev, visible: false }))}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    backgroundColor: colors.card, // O un color oscuro sólido si prefieres
    paddingBottom: spacing.xl,
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    ...shadows.card,
    alignItems: "center",
  },
  headerContent: {
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  successIconBubble: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#10B981", // Success
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.md,
    ...shadows.elevated,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.foreground,
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: "center",
  },
  scrollContent: {
    padding: spacing.lg,
    paddingTop: spacing.xl,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    ...shadows.card,
    marginBottom: spacing.xl,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardCapture: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    paddingTop: spacing.md,
    ...shadows.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  captureAreaPrimary: {
    backgroundColor: colors.background,
    padding: spacing.xl,
    borderRadius: borderRadius.xl,
  },
  captureHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  miniLogo: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  captureBrand: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.foreground,
    letterSpacing: 2,
  },
  captureFooter: {
    padding: spacing.md,
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderStyle: "dashed",
    marginTop: spacing.sm,
  },
  captureFooterText: {
    fontSize: 10,
    color: colors.mutedForeground,
    opacity: 0.7,
  },
  amountSection: {
    padding: spacing.lg,
    alignItems: "center",
  },
  amountValue: {
    fontSize: 36,
    fontWeight: "bold",
    color: colors.foreground,
  },
  dashedDivider: {
    height: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    marginHorizontal: spacing.lg,
  },
  detailsSection: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  label: {
    fontSize: 12,
    color: colors.mutedForeground,
    marginBottom: 2,
  },
  value: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.foreground,
  },
  metaValue: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.foreground,
  },
  idValue: {
    fontFamily: Platform.OS === "ios" ? "Courier" : "monospace",
    color: colors.accent,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(47, 128, 237, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    opacity: 0.5,
  },
  metaRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  actions: {
    gap: spacing.md,
  },
  horizontalActions: {
    flexDirection: "row",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  halfButton: {
    flex: 1,
    height: 50,
  },
  shareButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  homeButton: {
    width: "100%",
  },
});
