import React, { useState, useMemo, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    Switch,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScreenHeader } from '../../components/layout';
import { FormInput } from '../../components/register/FormInput';
import { Button, AlertDialog, PinPromptDialog } from '../../components/ui';
import { spacing, borderRadius } from '../../theme';
import { useTheme } from '../../context/ThemeContext';

import { useAuth } from '../../context/AuthContext';
import { updateWebAccess } from '../../services/auth.service';

export default function WebAccessScreen() {
    const { colors } = useTheme();
    const { user, refreshUser } = useAuth();
    const [webAccessEnabled, setWebAccessEnabled] = useState(false);
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [isPasswordFocused, setIsPasswordFocused] = useState(false);
    const [pinPromptVisible, setPinPromptVisible] = useState(false);

    useEffect(() => {
        if (user) {
            setWebAccessEnabled(user.web_access_enabled || false);
        }
    }, [user]);

    const [alertConfig, setAlertConfig] = useState<{
        visible: boolean;
        title: string;
        description: string;
        variant?: 'default' | 'destructive';
    }>({
        visible: false,
        title: '',
        description: '',
    });

    const showAlert = (title: string, description: string, variant: 'default' | 'destructive' = 'default') => {
        setAlertConfig({ visible: true, title, description, variant });
    };

    const styles = useMemo(() => createStyles(colors), [colors]);

    const passwordRequirements = useMemo(() => ([
        { id: 1, label: "Mínimo 8 caracteres", met: password.length >= 8 },
        { id: 2, label: "Al menos 1 Mayúscula", met: /[A-Z]/.test(password) },
        { id: 3, label: "Al menos 1 Número", met: /[0-9]/.test(password) },
        { id: 4, label: "Al menos 1 Carácter especial (!@#$%)", met: /[!@#$%^&*(),.?":{}|<>]/.test(password) },
    ]), [password]);

    const isPasswordValid = passwordRequirements.every((req) => req.met);
    const passwordsMatch = password === confirmPassword && password !== '';

    const handleSave = async () => {
        if (!user) return;

        if (!webAccessEnabled) {
            setLoading(true);
            const res = await updateWebAccess(false);
            setLoading(false);
            if (res.success) {
                await refreshUser();
                showAlert("Éxito", "Configuración de Acceso Web desactivada.");
            } else {
                showAlert("Error", res.error || "No se pudo actualizar.", "destructive");
            }
            return;
        }

        if (!password || !confirmPassword) {
            showAlert("Error", "Por favor completa los campos de contraseña.", "destructive");
            return;
        }

        if (!isPasswordValid) {
            showAlert("Error", "La contraseña no cumple con los requisitos de seguridad.", "destructive");
            return;
        }

        if (!passwordsMatch) {
            showAlert("Error", "Las contraseñas no coinciden.", "destructive");
            return;
        }

        // Activar el acceso o cambiar la contraseña exige el PIN
        setPinPromptVisible(true);
    };

    const handleConfirmPin = async (pin: string) => {
        setLoading(true);
        const res = await updateWebAccess(true, pin, password);
        setLoading(false);
        setPinPromptVisible(false);

        if (res.success) {
            await refreshUser();
            showAlert("Éxito", "Configuración de Acceso Web actualizada.");
            setPassword('');
            setConfirmPassword('');
        } else {
            showAlert("Error", res.error || "No se pudo actualizar.", "destructive");
        }
    };

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <PinPromptDialog
                visible={pinPromptVisible}
                onClose={() => setPinPromptVisible(false)}
                onConfirm={handleConfirmPin}
                loading={loading}
                description="Ingresa tu PIN para guardar la contraseña de acceso web."
            />
            <ScreenHeader
                title="Acceso Web"
                showBackButton={true}
                onBack={() => {
                    if (router.canGoBack()) {
                        router.back();
                    } else {
                        router.push('/menu');
                    }
                }}
            />

            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
            >
                <ScrollView
                    contentContainerStyle={styles.scrollContent}
                    showsVerticalScrollIndicator={false}
                >
                    {/* Security Warning */}
                    <View style={styles.warningCard}>
                        <View style={styles.warningHeader}>
                            <Ionicons name="shield-half-outline" size={24} color={colors.warning} />
                            <Text style={styles.warningTitle}>Zona de Seguridad</Text>
                        </View>
                        <Text style={styles.warningText}>
                            Esta contraseña permite el acceso directo a tu cuenta Magnate vía navegadores web. Mantenla segura.
                        </Text>
                    </View>

                    {/* Web Access Toggle */}
                    <View style={styles.settingRow}>
                        <View style={styles.settingInfo}>
                            <Text style={styles.settingLabel}>Habilitar acceso web</Text>
                            <Text style={styles.settingDescription}>
                                Permite iniciar sesión mediante usuario y contraseña en la versión de escritorio.
                            </Text>
                        </View>
                        <Switch
                            value={webAccessEnabled}
                            onValueChange={setWebAccessEnabled}
                            trackColor={{ false: colors.border, true: colors.accentAlpha[40] }}
                            thumbColor={webAccessEnabled ? colors.accent : colors.mutedForeground}
                        />
                    </View>

                    {webAccessEnabled && (
                        <View style={styles.form}>
                            <View style={styles.sectionHeader}>
                                <Ionicons name="key-outline" size={20} color={colors.accent} />
                                <Text style={styles.sectionTitle}>Contraseña Web</Text>
                            </View>

                            <FormInput
                                label="Contraseña"
                                placeholder="••••••••"
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                icon="lock-closed-outline"
                                onFocus={() => setIsPasswordFocused(true)}
                                onBlur={() => setIsPasswordFocused(false)}
                            />

                            {/* Password Validator UI */}
                            {(isPasswordFocused || password.length > 0) && (
                                <View style={styles.validatorContainer}>
                                    <Text style={styles.validatorTitle}>Requisitos de seguridad:</Text>
                                    {passwordRequirements.map(req => (
                                        <View key={req.id} style={styles.requirementRow}>
                                            <Ionicons
                                                name={req.met ? "checkmark-circle" : "ellipse-outline"}
                                                size={16}
                                                color={req.met ? colors.success : colors.mutedForeground}
                                            />
                                            <Text style={[
                                                styles.requirementText,
                                                req.met && styles.requirementMet
                                            ]}>
                                                {req.label}
                                            </Text>
                                        </View>
                                    ))}
                                </View>
                            )}

                            <FormInput
                                label="Confirmar Contraseña"
                                placeholder="••••••••"
                                value={confirmPassword}
                                onChangeText={setConfirmPassword}
                                secureTextEntry
                                icon="lock-closed-outline"
                                error={confirmPassword && !passwordsMatch ? "Las contraseñas no coinciden" : undefined}
                            />

                            <Button
                                onPress={handleSave}
                                loading={loading}
                                disabled={loading || !password || !isPasswordValid || !passwordsMatch}
                                style={styles.actionButton}
                            >
                                Cambiar Contraseña
                            </Button>
                        </View>
                    )}

                    <View style={{ height: 40 }} />
                </ScrollView>
            </KeyboardAvoidingView>

            <AlertDialog
                visible={alertConfig.visible}
                title={alertConfig.title}
                description={alertConfig.description}
                variant={alertConfig.variant}
                onConfirm={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
                onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
            />
        </SafeAreaView>
    );
}

const createStyles = (colors: any) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    scrollContent: {
        padding: spacing.lg,
        gap: spacing.xl,
    },
    warningCard: {
        backgroundColor: colors.background,
        borderRadius: borderRadius.xl,
        borderWidth: 1,
        borderColor: colors.warningAlpha[40],
        padding: spacing.md,
        gap: spacing.xs,
    },
    warningHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    warningTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: colors.warning,
    },
    warningText: {
        fontSize: 12,
        color: colors.mutedForeground,
        lineHeight: 18,
    },
    settingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.card,
        padding: spacing.md,
        borderRadius: borderRadius.xl,
        borderWidth: 1,
        borderColor: colors.border,
    },
    settingInfo: {
        flex: 1,
        marginRight: spacing.md,
    },
    settingLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.foreground,
    },
    settingDescription: {
        fontSize: 12,
        color: colors.mutedForeground,
        marginTop: 2,
    },
    form: {
        gap: spacing.lg,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.xs,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '700',
        color: colors.foreground,
    },
    validatorContainer: {
        backgroundColor: colors.mutedAlpha[30],
        padding: spacing.md,
        borderRadius: borderRadius.xl,
        gap: spacing.xs,
        borderWidth: 1,
        borderColor: colors.border,
    },
    validatorTitle: {
        fontSize: 12,
        fontWeight: '700',
        color: colors.foreground,
        marginBottom: 4,
    },
    actionButton: {
        marginTop: spacing.md,
        height: 56,
        backgroundColor: colors.accent,
    },
    requirementRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
    },
    requirementText: {
        fontSize: 12,
        color: colors.mutedForeground,
    },
    requirementMet: {
        color: colors.success,
        fontWeight: '500',
    },
});
