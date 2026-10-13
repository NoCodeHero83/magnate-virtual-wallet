import React, { useState, useMemo, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { spacing } from "../../theme";
import { ScreenHeader } from "../../components/layout";
import { AmountInput, RecipientInput } from "../../components/transfer";
import { Input, Button } from "../../components/ui";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useTheme } from "../../context/ThemeContext";
import { useAuth } from "../../context/AuthContext";
import { transactionService } from "../../services/transaction.service";
import { getAccountLimits } from "../../services/account.service";
import { AccountLimit } from "../../types/database.types";
import { parseAmount, formatCurrency } from "../../utils/formatters";
import { getSupportEmail } from "../../services/settings.service";
import { withOperationalAccount } from '../../components/account/AccountStatusGate';
import { setPendingTransfer } from "../../services/pendingTransfer";

function TransferScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { account } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams();
  const [recipient, setRecipient] = useState("");
  const [recipientData, setRecipientData] = useState<any>(null);
  const [amount, setAmount] = useState("0");
  const [concept, setConcept] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [limits, setLimits] = useState<
    (AccountLimit & { percentUsed: number }) | null
  >(null);
  const [loadingLimits, setLoadingLimits] = useState(true);
  const [supportEmail, setSupportEmail] = useState('soporte@magnate.com');

  // Pre-fill recipient if passed via params (e.g. from QR scan)
  useEffect(() => {
    if (params.recipient && typeof params.recipient === "string") {
      setRecipient(params.recipient);
    }
  }, [params.recipient]);

  // Fetch account limits on mount
  useEffect(() => {
    if (account?.id) {
      loadLimits();
    }
  }, [account?.id]);

  // Fetch support email on mount
  useEffect(() => {
    getSupportEmail().then(setSupportEmail);
  }, []);

  const loadLimits = async () => {
    try {
      setLoadingLimits(true);
      const data = await getAccountLimits(account!.id);
      setLimits(data);
    } catch (error) {
      console.error("Error loading account limits:", error);
    } finally {
      setLoadingLimits(false);
    }
  };

  const styles = useMemo(() => createStyles(colors), [colors]);

  const numericAmount = parseAmount(amount);

  // --- Limit validation ---
  const monthlyAvailable = limits ? limits.monthly_available : Infinity;
  const dailyAvailable =
    limits?.daily_limit != null
      ? limits.daily_limit - limits.daily_spent
      : Infinity;
  const perTransactionMax = limits?.per_transaction_limit ?? Infinity;

  // Check which specific limit is violated
  const getLimitError = (): string | null => {
    if (numericAmount <= 0) return null;

    if (numericAmount > (account?.balance || 0)) {
      return "Saldo insuficiente";
    }
    if (perTransactionMax !== Infinity && numericAmount > perTransactionMax) {
      return `Máximo por transacción: ${formatCurrency(perTransactionMax)}`;
    }
    if (dailyAvailable !== Infinity && numericAmount > dailyAvailable) {
      if (dailyAvailable <= 0) {
        return `Límite diario alcanzado. Por favor contactarse al correo ${supportEmail}`;
      }
      return `Disponible hoy: ${formatCurrency(dailyAvailable)}`;
    }
    if (monthlyAvailable !== Infinity && numericAmount > monthlyAvailable) {
      if (monthlyAvailable <= 0) {
        return `Límite mensual alcanzado. Por favor contactarse al correo ${supportEmail}`;
      }
      return `Disponible este mes: ${formatCurrency(monthlyAvailable)}`;
    }
    return null;
  };

  const limitError = getLimitError();

  // Check if limits are completely exhausted (disable button permanently)
  const isLimitExhausted =
    limits != null &&
    ((monthlyAvailable !== Infinity && monthlyAvailable <= 0) ||
      (dailyAvailable !== Infinity && dailyAvailable <= 0));

  // Validar visualmente mientras escribe (longitud mínima)
  const isRecipientValid = !!recipientData;
  const isAmountValid =
    numericAmount > 0 &&
    numericAmount <= (account?.balance || 0) &&
    limitError === null;
  const canTransfer =
    isRecipientValid && isAmountValid && !isLimitExhausted && !loadingLimits;

  const handleTransfer = async () => {
    if (!canTransfer) return;

    // Los datos van en memoria, no en la ruta: un link externo no puede armar la confirmación
    setPendingTransfer({
      amount,
      recipientName: recipientData.holder,
      concept,
      isExternal: !!recipientData.isExternal,
      identifier: recipient,
    });
    router.push("/payment/confirm");
  };

  const handleValidationChange = (isValid: boolean, data?: any) => {
    if (isValid && data) {
      console.log("data", data);
      setRecipientData(data);
    } else {
      setRecipientData(null);
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Transferir"
        showBackButton={true}
        showAvatar={true}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 90 },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <RecipientInput
            value={recipient}
            onChangeText={setRecipient}
            onValidationChange={handleValidationChange}
          />

          <AmountInput
            value={amount}
            onChange={setAmount}
            availableBalance={account?.balance || 0}
          />

          {/* Limit warning message */}
          {limitError && numericAmount > 0 && (
            <View style={styles.limitWarning}>
              <Text style={styles.limitWarningText}>{limitError}</Text>
            </View>
          )}

          {/* Show exhausted limits warning */}
          {isLimitExhausted && (
            <View style={styles.limitExhausted}>
              <Text style={styles.limitExhaustedText}>
                Has alcanzado tu límite de transacciones.{"\n"}Por favor contactarse al correo {supportEmail}
              </Text>
            </View>
          )}

          <Input
            label="Concepto (Opcional)"
            placeholder="Varios"
            value={concept}
            onChangeText={setConcept}
            containerStyle={styles.inputContainer}
          />

          <View style={styles.spacer} />

          <Button
            onPress={handleTransfer}
            disabled={!canTransfer || isLoading}
            variant={canTransfer ? "primary" : "outline"}
            style={{ width: "100%" }}
          >
            {isLoading
              ? "Procesando..."
              : isLimitExhausted
                ? "Límite alcanzado"
                : "Transferir"}
          </Button>

          {/* Helper text if disabled */}
          {!canTransfer &&
            !isLimitExhausted &&
            !limitError &&
            (numericAmount > 0 || recipient.length > 0) && (
              <Text style={styles.helperText}>
                {numericAmount > (account?.balance || 0)
                  ? "Saldo insuficiente"
                  : !isRecipientValid && recipient.length > 0
                    ? "Destinatario inválido"
                    : "Completa los campos para continuar"}
              </Text>
            )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const createStyles = (colors: any) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    content: {
      padding: spacing.lg,
      paddingBottom: spacing.xl * 2,
    },
    inputContainer: {
      marginBottom: spacing.lg,
    },
    spacer: {
      height: spacing.xl,
    },
    helperText: {
      marginTop: spacing.md,
      textAlign: "center",
      color: colors.mutedForeground,
      fontSize: 12,
    },
    limitWarning: {
      backgroundColor: colors.warning + "15",
      borderWidth: 1,
      borderColor: colors.warning + "40",
      borderRadius: 12,
      padding: spacing.md,
      marginBottom: spacing.md,
      alignItems: "center",
    },
    limitWarningText: {
      color: colors.warning,
      fontSize: 12,
      fontWeight: "600",
      textAlign: "center",
    },
    limitExhausted: {
      backgroundColor: colors.destructive + "15",
      borderWidth: 1,
      borderColor: colors.destructive + "40",
      borderRadius: 12,
      padding: spacing.md,
      marginBottom: spacing.md,
      alignItems: "center",
    },
    limitExhaustedText: {
      color: colors.destructive,
      fontSize: 12,
      fontWeight: "600",
      textAlign: "center",
      lineHeight: 18,
    },
  });

export default withOperationalAccount(TransferScreen);
