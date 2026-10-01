import React from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { FormInput } from "./FormInput";
import { Button } from "../ui/Button";
import { colors, spacing, typography, borderRadius } from "../../theme";
import { BiometricCard } from "./BiometricCard";
import { formatCUITCUIL, formatDNI, validateEmail, validatePhone, validateDNI, validateName, validateCUITCUIL } from "../../utils/validators";
import { AlertDialog } from "../ui/AlertDialog";
import { isTestEnv } from "../../config/environment";

interface FormData {
  nombres: string;
  apellidos: string;
  email: string;
  telefono: string;
  dni: string;
  cuit: string;
  zapsign_doc_token?: string;
  zapsign_data?: any;
}

interface StepFormDataProps {
  formData: FormData;
  onChange: (field: keyof FormData, value: any) => void;
  onContinue: () => void;
  isValid: boolean;
  title?: string;
  subtitle?: string;
}

export const StepFormData: React.FC<StepFormDataProps> = ({
  formData,
  onChange,
  onContinue,
  isValid,
  title = "Datos Personales",
  subtitle = "Completa tu información para configurar tu perfil de inversor en Magnate.",
}) => {
  const [alertVisible, setAlertVisible] = React.useState(false);
  const [alertMessage, setAlertMessage] = React.useState("");

  const localNameValid = validateName(formData.nombres);
  const localLastNameValid = validateName(formData.apellidos);
  const localEmailValid = validateEmail(formData.email);
  const localPhoneValid = validatePhone(formData.telefono);
  const localDniValid = validateDNI(formData.dni);
  const localCuitValid = isTestEnv ? true : validateCUITCUIL(formData.cuit);
  const docVerified = !!formData.zapsign_doc_token; // requerido en sandbox y producción
  const localFormValid =
    localNameValid &&
    localLastNameValid &&
    localEmailValid &&
    localPhoneValid &&
    localDniValid &&
    localCuitValid &&
    docVerified;

  const handlePressContinue = () => {
    if (localFormValid) {
      onContinue();
      return;
    }
    const unmet: string[] = [];
    if (!localNameValid) unmet.push("Nombre inválido");
    if (!localLastNameValid) unmet.push("Apellido inválido");
    if (!localEmailValid) unmet.push("Email inválido");
    if (!localPhoneValid) unmet.push("Teléfono inválido");
    if (!localDniValid) unmet.push("DNI inválido");
    if (!localCuitValid) unmet.push("CUIT/CUIL inválido");
    if (!docVerified) unmet.push("Verificación de identidad pendiente");
    const message = `Revisa los siguientes puntos:\n• ${unmet.join("\n• ")}`;
    setAlertMessage(message);
    setAlertVisible(true);
  };
  
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentContainerStyle={[
        styles.container,
        { paddingBottom: spacing.xl + insets.bottom },
      ]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
      </View>

      <View style={styles.form}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <FormInput
              label="Nombres"
              placeholder="Juan"
              value={formData.nombres}
              onChangeText={(text) => onChange("nombres", text)}
            />
          </View>
          <View style={{ flex: 1 }}>
            <FormInput
              label="Apellidos"
              placeholder="Pérez"
              value={formData.apellidos}
              onChangeText={(text) => onChange("apellidos", text)}
            />
          </View>
        </View>

        <FormInput
          label="Email"
          icon="mail-outline"
          keyboardType="email-address"
          autoCapitalize="none"
          placeholder="nombre@correo.com"
          value={formData.email}
          onChangeText={(text) => onChange("email", text)}
        />

        <FormInput
          label="Teléfono Móvil"
          icon="phone-portrait-outline"
          keyboardType="phone-pad"
          placeholder="+54 9 11 1234 5678"
          value={formData.telefono}
          onChangeText={(text) => onChange("telefono", text)}
        />

        <FormInput
          label="DNI"
          placeholder="00.000.000"
          keyboardType="numeric"
          maxLength={10} // XX.XXX.XXX
          value={formData.dni}
          onChangeText={(text) => onChange("dni", formatDNI(text))}
          rightElement={
            <View style={styles.secureBadge}>
              <Ionicons name="lock-closed" size={12} color={colors.accent} />
              <Text style={styles.secureText}>Seguro</Text>
            </View>
          }
        />

        <FormInput
          label="CUIT / CUIL"
          placeholder="00-00000000-0"
          keyboardType="numeric"
          maxLength={13} // XX-XXXXXXXX-X
          value={formData.cuit}
          onChangeText={(text) => onChange("cuit", formatCUITCUIL(text))}
        />

        <View style={styles.divider} />

        {/* Biometric Card */}
        <BiometricCard 
          userName={`${formData.nombres} ${formData.apellidos}`.trim()}
  userEmail={formData.email}
  onSignatureSuccess={(token, contractUrl, biometric) => {
    onChange('zapsign_doc_token', token);
    if (contractUrl) {
      onChange('zapsign_contract_url' as any, contractUrl);
    }
    if (biometric) {
      onChange('zapsign_data', biometric);
    }
  }}
/>

        <Text style={styles.termsText}>
          Al continuar, aceptas los{" "}
          <Text style={styles.link}>Términos de Servicio</Text> y la{" "}
          <Text style={styles.link}>Política de Privacidad</Text> de Magnate.
        </Text>

        <Button onPress={handlePressContinue} disabled={false} style={styles.button}>
          Continuar
          <Ionicons
            name="arrow-forward"
            size={20}
            color={colors.accentForeground}
            style={{ marginLeft: 8 }}
          />
        </Button>
        <AlertDialog
          visible={alertVisible}
          onClose={() => setAlertVisible(false)}
          onConfirm={() => setAlertVisible(false)}
          title="No pudimos continuar"
          description={alertMessage}
          confirmLabel="Entendido"
          showCancel={false}
          icon="alert-circle"
          variant="destructive"
        />
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingBottom: spacing.xl,
  },
  header: {
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    color: colors.foreground,
    marginBottom: spacing.xs,
  },
  subtitle: {
    fontSize: 14,
    color: colors.mutedForeground,
    lineHeight: 20,
  },
  form: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  row: {
    flexDirection: "row",
    gap: spacing.md,
  },
  secureBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  secureText: {
    fontSize: 12,
    color: colors.accent,
    fontWeight: "500",
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.sm,
  },
  biometricCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.card,
    padding: spacing.md,
    borderRadius: borderRadius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.md,
  },
  biometricIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(47, 128, 237, 0.1)",
    justifyContent: "center",
    alignItems: "center",
  },
  biometricTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: colors.foreground,
  },
  biometricDesc: {
    fontSize: 12,
    color: colors.mutedForeground,
  },
  biometricToggle: {
    width: 40,
    height: 22,
    backgroundColor: colors.border,
    borderRadius: 11,
    padding: 2,
    justifyContent: "center",
  },
  toggleDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#fff",
  },
  termsText: {
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: "center",
    lineHeight: 18,
    marginVertical: spacing.md,
  },
  link: {
    color: colors.accent,
    fontWeight: "500",
  },
  button: {
    height: 56,
    borderRadius: borderRadius.xl,
    marginTop: spacing.sm,
  },
});
