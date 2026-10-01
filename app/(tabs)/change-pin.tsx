import React, { useState, useEffect, useCallback } from "react";
import { useFocusEffect } from '@react-navigation/native';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";

import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { colors, spacing, borderRadius, typography } from "../../theme";
import { PIN_LENGTH } from "../../constants/app";
import { ScreenHeader } from "../../components/layout";
import {
  logout,
  requestPinChangeCode,
  confirmPinChange,
} from "../../services/auth.service";
import { AlertDialog, Toast, Button } from "../../components/ui";


type Step = "current" | "otp" | "new" | "confirm";

const BUTTON_SIZE = 72;

const shuffleArray = (array: number[]): number[] => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

export default function ChangePinScreen() {
  const [step, setStep] = useState<Step>("current");
  const [currentPin, setCurrentPin] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [keypadNumbers, setKeypadNumbers] = useState<number[]>([]);
  const [showLogoutAlert, setShowLogoutAlert] = useState(false);
  const [toast, setToast] = useState<{
    visible: boolean;
    message: string;
    type: "success" | "error";
  }>({
    visible: false,
    message: "",
    type: "error",
  });

  const insets = useSafeAreaInsets();

  // Reset state on mount to ensure clean slate
  useFocusEffect(
  useCallback(() => {
    setStep("current");
    setCurrentPin("");
    setOtpCode("");
    setNewPin("");
    setConfirmPin("");
    setLoading(false);
  }, [])
);

  useEffect(() => {
    setKeypadNumbers(shuffleArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]));
  }, [step]);

  const currentInputLength = step === "otp" ? 6 : PIN_LENGTH;

  const currentVal =
    step === "current"
      ? currentPin
      : step === "otp"
        ? otpCode
        : step === "new"
          ? newPin
          : confirmPin;

  const updateVal = (val: string) => {
    if (step === "current") setCurrentPin(val);
    else if (step === "otp") setOtpCode(val);
    else if (step === "new") setNewPin(val);
    else setConfirmPin(val);
  };

  const showToast = (message: string, type: "success" | "error" = "error") => {
    setToast({ visible: true, message, type });
  };

  const handleDigitPress = (digit: number) => {
    if (loading) return;

    if (currentVal.length < currentInputLength) {
      const newVal = currentVal + digit.toString();
      updateVal(newVal);

      if (newVal.length === currentInputLength) {
        if (step === "current") {
          handleVerifyCurrentPin(newVal);
        } else if (step === "otp") {
          handleVerifyOtp(newVal);
        } else if (step === "new") {
          setTimeout(() => setStep("confirm"), 300);
        } else {
          if (newVal === newPin) {
            handleUpdatePin(newVal);
          } else {
            setTimeout(() => {
              showToast("Los PINs no coinciden. Intenta nuevamente.");
              setConfirmPin("");
            }, 300);
          }
        }
      }
    }
  };

  const handleVerifyCurrentPin = async (pin: string) => {
    setLoading(true);
    // El servidor valida el PIN actual (con bloqueo por intentos) y envía el código
    const result = await requestPinChangeCode(pin);
    setLoading(false);
    if (result.success) {
      showToast("Código enviado a tu email", "success");
      setStep("otp");
    } else {
      showToast(result.error || "No se pudo enviar el código");
      setCurrentPin("");
    }
  };

  const handleVerifyOtp = async (code: string) => {
    // El código se valida en el servidor junto con el nuevo PIN.
    // Si ya se eligió el nuevo PIN (reintento tras un código incorrecto), confirmar directo.
    if (newPin.length === PIN_LENGTH && confirmPin === newPin) {
      await handleUpdatePin(newPin, code);
      return;
    }
    setTimeout(() => setStep("new"), 300);
  };

  const handleDelete = () => {
    if (loading) return;
    if (currentVal.length > 0) {
      updateVal(currentVal.slice(0, -1));
    }
  };

  const handleLogout = async () => {
    setLoading(true);
    const result = await logout();
    setLoading(false);
    if (result.success) {
      router.replace("/login");
    } else {
      showToast(result.error || "Error al cerrar sesión");
    }
  };

  const handleUpdatePin = async (confirmedPin: string, code: string = otpCode) => {
    setLoading(true);
    const result = await confirmPinChange(code, confirmedPin);
    setLoading(false);
    if (result.success) {
      showToast("PIN actualizado correctamente", "success");
      setTimeout(() => {
        setShowLogoutAlert(true);
      }, 1500);
      return;
    }

    showToast(result.error || "Error al actualizar el PIN");
    switch (result.code) {
      case "INVALID_CODE":
        // Reintentar solo el código, manteniendo el nuevo PIN
        setOtpCode("");
        setStep("otp");
        break;
      case "SAME_PIN":
      case "INVALID_NEW_PIN":
        setNewPin("");
        setConfirmPin("");
        setStep("new");
        break;
      default:
        // Código vencido / demasiados intentos / sesión: empezar de nuevo
        setCurrentPin("");
        setOtpCode("");
        setNewPin("");
        setConfirmPin("");
        setStep("current");
    }
  };

  const getTitle = () => {
    switch (step) {
      case "current":
        return "PIN Actual";
      case "otp":
        return "Verificación Email";
      case "new":
        return "Nuevo PIN";
      case "confirm":
        return "Confirmar PIN";
    }
  };

  const getSubtitle = () => {
    switch (step) {
      case "current":
        return "Ingresa tu PIN actual para continuar";
      case "otp":
        return "Ingresa el código de 6 dígitos enviado a tu email";
      case "new":
        return "Crea tu nuevo PIN de acceso";
      case "confirm":
        return "Ingresa nuevamente tu nuevo PIN";
    }
  };

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.background, paddingTop: insets.top },
      ]}
    >
      <ScreenHeader
        title="Cambiar PIN"
        showBackButton={true}
        onBack={() => router.back()}
      />

      <View
        style={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
      >
        {/* Icon */}
        <View style={styles.iconContainer}>
          <Ionicons
            name={
              step === "current"
                ? "lock-open-outline"
                : step === "otp"
                  ? "mail-outline"
                  : "shield-checkmark-outline"
            }
            size={40}
            color={colors.accent}
          />
        </View>

        {/* Text */}
        <Text style={styles.title}>{getTitle()}</Text>
        <Text style={styles.subtitle}>{getSubtitle()}</Text>

        {/* Dots */}
        <View style={styles.dotsContainer}>
          {Array.from({ length: currentInputLength }).map((_, i) => (
            <View
              key={i}
              style={[
                styles.dot,
                i < currentVal.length ? styles.activeDot : null,
              ]}
            />
          ))}
        </View>

        {/* Keypad */}
        <View style={styles.keypad}>
          {[0, 1, 2, 3].map((row) => (
            <View key={row} style={styles.keypadRow}>
              {row < 3 ? (
                keypadNumbers.slice(row * 3, (row + 1) * 3).map((num) => (
                  <TouchableOpacity
                    key={num}
                    style={styles.keypadButton}
                    onPress={() => handleDigitPress(num)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.keypadText}>{num}</Text>
                  </TouchableOpacity>
                ))
              ) : (
                <>
                  <View style={styles.keypadPlaceholder} />
                  <TouchableOpacity
                    style={styles.keypadButton}
                    onPress={() => handleDigitPress(keypadNumbers[9])}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.keypadText}>{keypadNumbers[9]}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.keypadButton}
                    onPress={handleDelete}
                    activeOpacity={0.7}
                  >
                    <Ionicons
                      name="backspace-outline"
                      size={24}
                      color={colors.foreground}
                    />
                  </TouchableOpacity>
                </>
              )}
            </View>
          ))}
        </View>

        <View style={styles.securityInfo}>
          <Ionicons
            name="lock-closed-outline"
            size={14}
            color={colors.mutedForeground}
          />
          <Text style={styles.securityText}>
            El teclado aleatorio protege contra rastro de patrones
          </Text>
        </View>
        <Button
          variant="destructive"
          onPress={() => {
            setCurrentPin("");
            setOtpCode("");
            setNewPin("");
            setConfirmPin("");
            setStep("current");
            router.back();
          }}
          style={styles.btnCancel}
        >
          Cancelar
        </Button>
      </View>

      {loading && (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      )}

      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onHide={() => setToast((prev) => ({ ...prev, visible: false }))}
      />

      <AlertDialog
        visible={showLogoutAlert}
        title="Su pin ha sido actualizado correctamente"
        description="Para mayor seguridad, se cerrará sesión."
        confirmLabel="Salir"
        variant="destructive"
        showCancel={false}
        icon="log-out-outline"
        loading={loading}
        onConfirm={handleLogout}
        onClose={() => !loading && setShowLogoutAlert(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
  },
  iconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accentAlpha?.["10"] || "rgba(47, 128, 237, 0.1)",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: spacing.base,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.foreground,
    textAlign: "center",
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: "center",
    marginBottom: spacing.xl * 1.5,
  },
  dotsContainer: {
    flexDirection: "row",
    gap: 16,
    marginBottom: spacing.xl * 2,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.border,
  },
  activeDot: {
    backgroundColor: colors.accent,
    transform: [{ scale: 1.2 }],
  },
  keypad: {
    gap: spacing.md,
    width: "100%",
    maxWidth: 320,
  },
  keypadRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: spacing.md,
  },
  keypadButton: {
    width: BUTTON_SIZE,
    aspectRatio: 1,
    backgroundColor: colors.card,
    borderRadius: borderRadius.xl,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: colors.border,
  },
  keypadPlaceholder: {
    width: BUTTON_SIZE,
    aspectRatio: 1,
  },
  keypadText: {
    fontSize: 24,
    fontWeight: "600",
    color: colors.foreground,
  },
  securityInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: spacing.xl,
  },
  securityText: {
    fontSize: 11,
    color: colors.mutedForeground,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 100,
  },
  btnCancel: {
    marginTop: spacing.xl,
    borderWidth: 1,
  },
});
