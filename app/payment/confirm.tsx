import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  TextInput,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import {
  colors,
  spacing,
  typography,
  borderRadius,
  shadows,
} from "../../theme";
import { formatCurrency, getInitials } from "../../utils/formatters";
import { Button, AlertDialog } from "../../components/ui";
import { useAuth } from "../../context/AuthContext";
import { transactionService } from "../../services/transaction.service";
import { parseAmount } from "../../utils/formatters";
import { withOperationalAccount } from '../../components/account/AccountStatusGate';

function ConfirmScreen() {
  const { account } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams();
  console.log("params", params);

  // Extract params correctly
  const amount = typeof params.amount === "string" ? params.amount : "0";
  const recipient =
    typeof params.recipientName === "string"
      ? params.recipientName
      : "Desonocido";
  const concept = typeof params.concept === "string" ? params.concept : "";
  const toAccountId =
    typeof params.toAccountId === "string" ? params.toAccountId : "";
  const isExternal = params.isExternal === "true";
  const identifier =
    typeof params.identifier === "string" ? params.identifier : "";

  const [isLoading, setIsLoading] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    description: string;
    variant?: "default" | "destructive";
  }>({
    visible: false,
    title: "",
    description: "",
  });

  const showAlert = (
    title: string,
    description: string,
    variant: "default" | "destructive" = "default",
  ) => {
    setAlertConfig({ visible: true, title, description, variant });
  };

  const handleConfirm = async () => {
    if (!account || isLoading) return;
    setIsLoading(true);

    try {
      const method = identifier.length === 22 ? "cbu" : "alias";

      const result = await transactionService.transferFunds(
        account.id,
        identifier,
        parseAmount(amount),
        concept,
        method,
      );

      // Navigate to Success
      router.push({
        pathname: "/payment/success",
        params: {
          amount,
          recipientName: recipient,
          reference_number: result?.reference_number,
        },
      });
    } catch (error: any) {
      console.error(error);
      showAlert(
        "Error",
        error.message || "No se pudo realizar la transferencia",
        "destructive",
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backButton}
        >
          <Ionicons name="arrow-back" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Confirmar Transferencia</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Amount Display */}
        <View style={styles.amountContainer}>
          <Text style={styles.amountLabel}>Monto a transferir</Text>
          <Text style={styles.amountValue}>$ {amount}</Text>
        </View>

        {/* Recipient Card */}
        <View style={styles.card}>
          <View style={styles.recipientHeader}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{getInitials(recipient)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.recipientLabel}>Destinatario</Text>
              <Text style={styles.recipientName}>{recipient}</Text>
            </View>
          </View>

          <View style={styles.divider} />

          <View style={styles.cardRow}>
            <Text style={styles.rowLabel}>CBU/Alias</Text>
            <Text style={styles.rowValue} numberOfLines={1}>
              {recipient}
            </Text>
          </View>

          {concept ? (
            <View style={[styles.cardRow, { marginTop: spacing.md }]}>
              <Text style={styles.rowLabel}>Concepto</Text>
              <Text style={styles.rowValue} numberOfLines={1}>
                {concept}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Warning */}
        <View style={styles.warningBox}>
          <Text style={styles.warningText}>
            Revisa los datos antes de confirmar. Esta operación no puede
            deshacerse.
          </Text>
        </View>

        {/* Actions inline with content */}
        <View style={styles.actionsContainer}>
          <Button
            onPress={handleConfirm}
            style={styles.confirmButton}
            textStyle={{ fontSize: 16 }}
            loading={isLoading}
          >
            {!isLoading && (
              <>
                <Ionicons
                  name="send"
                  size={18}
                  color={colors.accentForeground}
                />
                <View style={{ width: 12 }} />
              </>
            )}
            Confirmar Transferencia
          </Button>

          <TouchableOpacity
            onPress={() => router.back()}
            style={styles.cancelButton}
            disabled={isLoading}
          >
            <Text style={styles.cancelText}>Cancelar</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      <AlertDialog
        visible={alertConfig.visible}
        title={alertConfig.title}
        description={alertConfig.description}
        variant={alertConfig.variant}
        confirmLabel="Entendido"
        onConfirm={() =>
          setAlertConfig((prev) => ({ ...prev, visible: false }))
        }
        onClose={() => setAlertConfig((prev) => ({ ...prev, visible: false }))}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  backButton: {
    padding: spacing.sm,
  },
  headerTitle: {
    fontSize: typography.sizes.lg,
    fontWeight: "600",
    marginLeft: spacing.sm,
    color: colors.foreground,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xl * 2,
  },
  amountContainer: {
    alignItems: "center",
    marginVertical: spacing.xl,
  },
  amountLabel: {
    color: colors.mutedForeground,
    marginBottom: spacing.xs,
  },
  amountValue: {
    fontSize: 40,
    fontWeight: "700",
    color: colors.foreground,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    padding: spacing.lg,
    ...shadows.sm,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.lg,
  },
  recipientHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
  },
  avatarText: {
    color: colors.accentForeground,
    fontWeight: "bold",
    fontSize: 18,
  },
  recipientLabel: {
    fontSize: 12,
    color: colors.mutedForeground,
  },
  recipientName: {
    fontSize: 18,
    fontWeight: "600",
    color: colors.foreground,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginBottom: spacing.md,
  },
  cardRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowLabel: {
    color: colors.mutedForeground,
    fontSize: 14,
  },
  rowValue: {
    color: colors.foreground,
    fontSize: 14,
    fontWeight: "500",
    maxWidth: 200,
  },
  warningBox: {
    backgroundColor: "rgba(47, 128, 237, 0.1)", // accent 10
    padding: spacing.md,
    borderRadius: borderRadius.lg,
    marginBottom: spacing.xl, // Separación con botones
  },
  warningText: {
    color: colors.accent,
    textAlign: "center",
    fontSize: 13,
  },
  actionsContainer: {
    marginTop: spacing.sm,
  },
  confirmButton: {
    marginBottom: spacing.md,
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  cancelButton: {
    alignItems: "center",
    padding: spacing.md,
  },
  cancelText: {
    color: colors.mutedForeground,
    fontSize: 16,
  },
});

export default withOperationalAccount(ConfirmScreen);
