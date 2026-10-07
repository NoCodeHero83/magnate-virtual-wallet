import React, { useMemo, useState, useEffect } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { spacing } from "../../theme";
import { ScreenHeader } from "../../components/layout";
import {
  ProfileHero,
  InfoCard,
  AliasManagement,
  OperationalLimitsCard,
  MenuSection,
} from "../../components/profile";
import { Button, AlertDialog } from "../../components/ui";
import { useTheme } from "../../context/ThemeContext";
import { useAuth } from "../../context/AuthContext";
import * as accountService from "../../services/account.service";
import { supabase } from "../../lib/supabase";
import { getDisplayName } from "../../utils/user";

const createStyles = (colors: any) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    content: {
      paddingBottom: spacing.xl * 2,
    },
    section: {
      padding: spacing.lg,
      gap: spacing.md,
    },
    logoutContainer: {
      marginTop: spacing.xl,
      gap: spacing.md,
    },
    logoutButton: {
      borderColor: colors.destructive,
      borderWidth: 1,
      width: "100%",
    },
    logoutText: {
      color: colors.destructive,
    },
    versionText: {
      textAlign: "center",
      fontSize: 10,
      color: colors.mutedForeground,
      fontFamily: "monospace",
    },
  });

export default function ProfileScreen() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { user, account, logout, session } = useAuth();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const [limits, setLimits] = useState<{
    monthlyLimit: number;
    amountOperated: number;
  } | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (account?.id) {
      loadLimits();
    }
    if (session?.user?.user_metadata?.avatar_url) {
      setAvatarUrl(session.user.user_metadata.avatar_url);
    }
  }, [account, session]);

  const [showLogoutAlert, setShowLogoutAlert] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{
    visible: boolean;
    title: string;
    description: string;
    variant?: "default" | "destructive";
    onConfirm?: () => void;
  }>({
    visible: false,
    title: "",
    description: "",
  });

  const loadLimits = async () => {
    if (!account) return;
    const data = await accountService.getAccountLimits(account.id);
    if (data) {
      setLimits({
        monthlyLimit: data.monthly_limit,
        amountOperated: data.monthly_spent,
      });
    }
  };

  const showAlert = (
    title: string,
    description: string,
    variant: "default" | "destructive" = "default",
    onConfirm?: () => void,
  ) => {
    setAlertConfig({
      visible: true,
      title,
      description,
      variant,
      onConfirm,
    });
  };

  const handleAvatarUpload = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: false,
        quality: 0.8,
      });

      if (!result.canceled && result.assets && result.assets.length > 0) {
        setIsUploading(true);
        const imageUri = result.assets[0].uri;
        const userId = session?.user?.id;
        if (!userId) {
          showAlert("Error", "Usuario no identificado", "destructive");
          setIsUploading(false);
          return;
        }

        // Prepare file for upload
        const response = await fetch(imageUri);
        const blob = await response.blob();
        const arrayBuffer = await new Response(blob).arrayBuffer();

        // Construct filename: images/profiles/{userId}/{timestamp}.jpg
        const fileName = `profiles/${userId}/${Date.now()}.jpg`;

        // Upload
        const { data, error } = await supabase.storage
          .from("images")
          .upload(fileName, arrayBuffer, {
            contentType: "image/jpeg",
            upsert: true,
          });

        if (error) {
          throw error;
        }

        // Get Public URL
        const {
          data: { publicUrl },
        } = supabase.storage.from("images").getPublicUrl(fileName);

        // 1. Update User Profile in DB (Source of Truth)
        const { error: dbError } = await (supabase.from("users") as any)
          .update({ photo_url: publicUrl })
          .eq("id", userId);

        if (dbError) {
          console.error("Error updating user profile in DB:", dbError);
        }

        // 2. Update Auth Metadata (Cache/Fallback)
        const { error: updateError } = await supabase.auth.updateUser({
          data: { avatar_url: publicUrl },
        });

        if (updateError) {
          console.warn("Could not update auth metadata", updateError);
        }

        setAvatarUrl(publicUrl);
      }
    } catch (error: any) {
      console.error(error);
      showAlert(
        "Error",
        "No se pudo subir la imagen. Intente nuevamente.",
        "destructive",
      );
    } finally {
      setIsUploading(false);
    }
  };

  const company = user?.account_type === "business" ? user.business_profile : null;
  const formatCuit = (cuit?: string | null) =>
    cuit && cuit.length === 11 ? `${cuit.slice(0, 2)}-${cuit.slice(2, 10)}-${cuit.slice(10)}` : cuit || "No registrado";
  const formatDate = (iso?: string | null) => {
    if (!iso) return "No registrada";
    const [y, m, d] = iso.split("-");
    return `${d}/${m}/${y}`;
  };

  const currentUser = {
    name: getDisplayName(user),
    subtitle:
      user?.verification_status === "pending"
        ? "Cuenta en revisión"
        : company
          ? "Persona Jurídica"
          : "Persona Física",
    isVerified: user?.verification_status === "verified",
    cuit: user?.cuit_cuil || "No registrado",
    dni: user?.dni || "No registrado",
    email: user?.email || "No registrado",
    phone: user?.phone || "No registrado",
  };

  const handleLogout = async () => {
    setIsLoggingOut(true);
    try {
      await logout();
      setShowLogoutAlert(false);
    } catch (error) {
      setIsLoggingOut(false);
    }
  };

  const handleChangePin = () => {
    router.push("/change-pin");
  };

  const securityItems = [
    ...(company
      ? [{
        icon: "document-text-outline" as const,
        label: "Documentación de la empresa",
        subtitle: "Estatuto, CUIT y representante",
        onPress: () => router.push("/profile/company-documents"),
      }]
      : []),
    {
      icon: "key-outline" as const,
      label: "Cambiar PIN de acceso",
      onPress: () => handleChangePin(),
    },
    {
      icon: "phone-portrait-outline" as const,
      label: "Dispositivos vinculados",
      subtitle: "Gestionar accesos",
      onPress: () => router.push("/profile/devices"),
    },
  ];

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <ScreenHeader
        title="Mi Perfil"
        showBackButton={true}
        showAvatar={false}
      />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 90 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <ProfileHero
          name={currentUser.name}
          subtitle={currentUser.subtitle}
          isVerified={currentUser.isVerified}
          avatarUrl={avatarUrl}
          onCameraPress={handleAvatarUpload}
          isUploading={isUploading}
        />

        <View style={styles.section}>
          {/* Operational Limits */}
          <OperationalLimitsCard
            monthlyLimit={limits?.monthlyLimit ?? 800000}
            amountOperated={limits?.amountOperated ?? 0}
          />
          {/* 
            dailyLimit={limits?.dailyLimit}
            dailySpent={limits?.dailySpent}
            perTransactionLimit={limits?.perTransactionLimit}*/}
          {/* Alias Management */}
          <AliasManagement userCuit={(company?.cuit ?? currentUser.cuit).replace(/-/g, "")} />

          {/* Company (Persona Jurídica) */}
          {company && (
            <InfoCard
              title="Empresa"
              fields={[
                { label: "Razón social", value: company.legal_name },
                ...(company.trade_name ? [{ label: "Nombre de fantasía", value: company.trade_name }] : []),
                { label: "CUIT", value: formatCuit(company.cuit) },
                { label: "Tipo societario", value: company.legal_entity?.name || company.legal_entity_type },
                { label: "Fecha de inscripción", value: formatDate(company.incorporation_date) },
              ]}
            />
          )}

          {/* Identity */}
          <InfoCard
            title={company ? "Representante legal" : "Identidad"}
            fields={[
              ...(company ? [{ label: "Nombre", value: `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim() }] : []),
              { label: "DNI", value: currentUser.dni },
              { label: "CUIT", value: currentUser.cuit },
            ]}
          />

          {/* Contact */}
          <InfoCard
            title="Contacto"
            fields={[
              { label: "Email", value: currentUser.email },
              { label: "Móvil", value: currentUser.phone },
            ]}
          />

          <View style={{ paddingHorizontal: 4, marginTop: 6 }}>
            <Button
              onPress={() =>
                showAlert("Guardar", "Datos guardados correctamente")
              }
              disabled={true}
            >
              Guardar
            </Button>
          </View>

          {/* Security */}
          <MenuSection title="Seguridad" items={securityItems} />

          <View style={styles.logoutContainer}>
            <Button
              variant="destructive"
              onPress={() => setShowLogoutAlert(true)}
              style={styles.logoutButton}
            >
              Cerrar Sesión
            </Button>
            <Text style={styles.versionText}>Magnate v2.4.0 (Build 892)</Text>
          </View>
        </View>
      </ScrollView>

      {/* Modals */}
      <AlertDialog
        visible={showLogoutAlert}
        title="Cerrar Sesión"
        description="¿Estás seguro que quieres salir de tu cuenta?"
        confirmLabel="Salir"
        cancelLabel="Cancelar"
        variant="destructive"
        icon="log-out-outline"
        loading={isLoggingOut}
        onConfirm={handleLogout}
        onClose={() => !isLoggingOut && setShowLogoutAlert(false)}
      />

      <AlertDialog
        visible={alertConfig.visible}
        title={alertConfig.title}
        description={alertConfig.description}
        variant={alertConfig.variant}
        confirmLabel="Entendido"
        onConfirm={() => {
          alertConfig.onConfirm?.();
          setAlertConfig((prev) => ({ ...prev, visible: false }));
        }}
        onClose={() => setAlertConfig((prev) => ({ ...prev, visible: false }))}
      />
    </View>
  );
}
