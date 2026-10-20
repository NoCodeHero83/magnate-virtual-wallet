import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
    Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';

import { Button, Input, AlertDialog, Toast, ToastType } from '../../components/ui';
import { LogoIcon } from '../../components/LogoIcon';
import { FeatureCard, PinIndicator, PinKeypad, LoginProcessingModal } from '../../components/login';
import { colors, spacing, borderRadius, typography } from '../../theme';
import { PIN_LENGTH, LEGACY_PIN_LENGTH, APP_VERSION } from '../../constants/app';
import { useAuth } from '../../context/AuthContext';
import { validateEmail, validatePIN } from '../../utils/validators';
import { getLastUser, clearLastUser, SavedUser } from '../../services/storage.service';

// Datos para las tarjetas de caracteristicas
const features = [
    {
        icon: <Ionicons name="shield-checkmark" size={32} color="white" />,
        label: 'Seguro',
        gradientColors: colors.featureGradient1 as [string, string, ...string[]],
    },
    {
        icon: <Ionicons name="people" size={32} color="white" />,
        label: 'Confiable',
        gradientColors: colors.featureGradient2 as [string, string, ...string[]],
    },
    {
        icon: <Ionicons name="flash" size={32} color="white" />,
        label: 'Eficaz',
        gradientColors: colors.featureGradient3 as [string, string, ...string[]],
    },
];

export default function LoginScreen() {
    const insets = useSafeAreaInsets();
    const { login, sessionEndedReason, clearSessionEndedReason } = useAuth();
    const [email, setEmail] = useState('');
    const [pin, setPin] = useState('');
    const [isLoading, setIsLoading] = useState(false);

    // New State for Persistent Login & UI
    const [savedUser, setSavedUser] = useState<SavedUser | null>(null);
    const [alert, setAlert] = useState({ visible: false, title: '', message: '', type: 'default' as 'default' | 'destructive' });
    const [toast, setToast] = useState({ visible: false, message: '', type: 'info' as ToastType });

    useEffect(() => {
        loadLastUser();
    }, []);

    // La sesión se cerró por el estado de la cuenta (rechazada / suspendida por un admin)
    useEffect(() => {
        if (sessionEndedReason) {
            setAlert({ visible: true, title: 'Sesión cerrada', message: sessionEndedReason, type: 'destructive' });
            clearSessionEndedReason();
        }
    }, [sessionEndedReason]);

    const loadLastUser = async () => {
        const user = await getLastUser();
        if (user) {
            setSavedUser(user);
            setEmail(user.email); // Set email for login function
        }
    };

    const handleSwitchAccount = async () => {
        await clearLastUser();
        setSavedUser(null);
        setEmail('');
        setPin('');
    };

    const showToast = (message: string, type: ToastType = 'info') => {
        setToast({ visible: true, message, type });
    };

    const showAlert = (title: string, message: string, type: 'default' | 'destructive' = 'default') => {
        setAlert({ visible: true, title, message, type });
    };

    const handleDigitPress = (digit: string) => {
        if (pin.length < PIN_LENGTH) {
            setPin((prev) => prev + digit);
        }
    };

    const handleBackspace = () => {
        setPin((prev) => prev.slice(0, -1));
    };

    const handleSubmit = async () => {
        // Validation Logic
        if (!savedUser && !email.trim()) {
            showToast('Por favor ingrese su correo electrónico', 'error');
            return;
        }

        if (!savedUser && !validateEmail(email)) {
            showToast('Email inválido', 'error');
            return;
        }

        // Un PIN de 4 dígitos (versión anterior) todavía entra; después se pide crear uno de 6
        if (pin.length !== PIN_LENGTH && pin.length !== LEGACY_PIN_LENGTH) {
            showToast(`Por favor ingrese su PIN de ${PIN_LENGTH} dígitos`, 'error');
            return;
        }

        setIsLoading(true);

        try {
            // If savedUser, email is already set in state from useEffect or we can use savedUser.email
            const loginEmail = savedUser ? savedUser.email : email;

            const result = await login(loginEmail, pin);

            if (result.success && result.requireDeviceVerification) {
                // Dispositivo nuevo: validar el código enviado por email
                router.push({
                    pathname: '/(auth)/verify-device',
                    params: {
                        email: loginEmail.trim().toLowerCase(),
                        sent: String(result.codeSent !== false),
                        ...(result.debugCode ? { debug: result.debugCode } : {}),
                    },
                });
                setPin('');
            } else if (result.success) {
                router.replace('/(tabs)');
            } else {
                if (result.error === 'Credenciales incorrectas' || result.error === 'PIN incorrecto' || result.error === 'Usuario no encontrado') {
                    showToast(result.error || 'Credenciales incorrectas', 'error');
                } else {
                    showAlert('Error de Inicio de Sesión', result.error || 'Ocurrió un error inesperado', 'destructive');
                }
                setPin('');
            }
        } catch (err: any) {
            showAlert('Error', err.message || 'Error al iniciar sesión', 'destructive');
            setPin('');
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {isLoading && <LoginProcessingModal />}

            <Toast
                visible={toast.visible}
                message={toast.message}
                type={toast.type}
                onHide={() => setToast((prev) => ({ ...prev, visible: false }))}
            />

            <AlertDialog
                visible={alert.visible}
                title={alert.title}
                description={alert.message}
                variant={alert.type}
                onClose={() => setAlert((prev) => ({ ...prev, visible: false }))}
                onConfirm={() => setAlert((prev) => ({ ...prev, visible: false }))}
                showCancel={false}
                confirmLabel="Entendido"
            />

            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardView}
            >
                <View style={styles.card}>
                    {/* Header */}
                    <View style={styles.header}>
                        <LogoIcon size={40} />
                        <Text style={styles.headerTitle}>Magnate</Text>
                    </View>

                    {/* Content */}
                    <ScrollView
                        style={styles.scrollView}
                        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 20 }]}
                        showsVerticalScrollIndicator={false}
                    >
                        {/* Feature Cards */}
                        <View style={styles.featuresGrid}>
                            {features.map((feature, index) => (
                                <FeatureCard
                                    key={index}
                                    icon={feature.icon}
                                    label={feature.label}
                                    gradientColors={feature.gradientColors}
                                    style={styles.featureCard}
                                />
                            ))}
                        </View>

                        {/* Email Input or Welcome Message */}
                        <View style={styles.inputSection}>
                            {savedUser ? (
                                <View style={styles.welcomeContainer}>
                                    <Text style={styles.welcomeSubtitle}>Hola de nuevo,</Text>
                                    <Text style={styles.welcomeTitle}>{savedUser.firstName}!</Text>
                                    {savedUser.avatarUrl && (
                                        // Placeholder for Avatar if we had one, or just the text
                                        <View style={{ height: 10 }} />
                                    )}
                                </View>
                            ) : (
                                <Input
                                    label="Usuario"
                                    value={email}
                                    onChangeText={(text) => {
                                        setEmail(text);
                                        // setError(null); // Error state removed
                                    }}
                                    placeholder="ejemplo@magnate.com"
                                    keyboardType="email-address"
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    icon={<Ionicons name="person-outline" size={20} color={colors.mutedForeground} />}
                                />
                            )}
                        </View>

                        {/* PIN Section */}
                        <View style={styles.pinSection}>
                            {/* PIN Title */}
                            <View style={styles.pinHeader}>
                                <Ionicons name="lock-closed" size={16} color={colors.accent} />
                                <Text style={styles.pinTitle}>Ingrese su PIN de {PIN_LENGTH} dígitos</Text>
                            </View>
                            <Text style={styles.pinHint}>
                                ¿Tu PIN es de {LEGACY_PIN_LENGTH} dígitos? Ingrésalo y te pediremos crear uno nuevo.
                            </Text>

                            {/* PIN Indicators */}
                            <View style={styles.pinIndicatorsContainer}>
                                <View style={styles.pinIndicators}>
                                    {Array.from({ length: PIN_LENGTH }).map((_, index) => (
                                        <PinIndicator key={index} filled={index < pin.length} />
                                    ))}
                                </View>
                            </View>

                            {/* Error Message Removed - using Toast/Alert */}

                            {/* PIN Keypad */}
                            <View style={styles.keypadContainer}>
                                <PinKeypad
                                    onDigitPress={handleDigitPress}
                                    onBackspace={handleBackspace}
                                />
                            </View>

                            {/* Actions */}
                            <View style={styles.actions}>
                                <Button
                                    onPress={handleSubmit}
                                    disabled={isLoading}
                                    loading={isLoading}
                                    variant="primary"
                                    style={styles.submitButton}
                                >
                                    {isLoading ? 'Ingresando...' : 'Ingresar'}
                                </Button>

                                {savedUser ? (
                                    <Button
                                        onPress={handleSwitchAccount}
                                        variant="ghost"
                                        textStyle={styles.registerText}
                                    >
                                        Ingresar con otra cuenta
                                    </Button>
                                ) : (
                                    <Button
                                        onPress={() => {
                                            router.push('/(auth)/register');
                                        }}
                                        variant="ghost"
                                        textStyle={styles.registerText}
                                    >
                                        Nuevo usuario? Registrate aquí
                                    </Button>
                                )}

                                <Button
                                    onPress={() => {
                                        router.push({ pathname: '/(auth)/forgot-password', params: email ? { email } : {} });
                                    }}
                                    variant="ghost"
                                    textStyle={styles.forgotText}
                                >
                                    ¿Olvidaste tu PIN?
                                </Button>
                            </View>

                            {/* Version */}
                            <Text style={styles.version}>{APP_VERSION}</Text>
                        </View>
                    </ScrollView>
                </View>
            </KeyboardAvoidingView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
        padding: spacing.base,
    },
    keyboardView: {
        flex: 1,
    },
    card: {
        flex: 1,
        backgroundColor: colors.card,
        borderRadius: borderRadius['2xl'],
        overflow: 'hidden',
        shadowColor: '#0A2540',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.15,
        shadowRadius: 20,
        elevation: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing.base,
        paddingHorizontal: spacing.base,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        gap: spacing.md,
    },
    headerTitle: {
        fontSize: typography.sizes.xl,
        fontWeight: '700',
        color: colors.foreground,
        letterSpacing: typography.letterSpacing.tight,
    },
    scrollView: {
        flex: 1,
    },
    scrollContent: {
        paddingBottom: spacing.lg,
    },
    featuresGrid: {
        flexDirection: 'row',
        gap: spacing.md,
        padding: spacing.base,
    },
    featureCard: {
        flex: 1,
    },
    inputSection: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: spacing.base,
    },
    pinSection: {
        backgroundColor: colors.card,
        borderTopLeftRadius: borderRadius['2xl'],
        borderTopRightRadius: borderRadius['2xl'],
        borderTopWidth: 1,
        borderTopColor: colors.border,
        marginTop: spacing.sm,
        padding: spacing.lg,
        alignItems: 'center',
    },
    pinHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.base,
    },
    pinTitle: {
        fontSize: typography.sizes.sm,
        fontWeight: '600',
        color: colors.foreground,
    },
    pinIndicatorsContainer: {
        width: '100%',
        justifyContent: 'center',
        marginBottom: spacing.md,
    },
    pinIndicators: {
        backgroundColor: colors.muted,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: borderRadius.xl,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.base,
        flexDirection: 'row',
        gap: spacing.sm,
        alignSelf: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 2,
    },
    errorContainer: {
        marginBottom: spacing.md,
    },
    errorText: {
        color: colors.destructive,
        fontSize: typography.sizes.sm,
        textAlign: 'center',
    },
    keypadContainer: {
        marginBottom: spacing.xl,
    },
    actions: {
        width: '100%',
        gap: spacing.base,
        alignItems: 'center',
    },
    submitButton: {
        width: '100%',
    },
    registerText: {
        fontSize: typography.sizes.sm,
        color: colors.accent,
    },
    pinHint: {
        fontSize: 12,
        color: colors.mutedForeground,
        textAlign: 'center',
        marginTop: -4,
        marginBottom: 8,
    },
    forgotText: {
        fontSize: typography.sizes.sm,
        color: colors.mutedForeground,
    },
    version: {
        fontSize: 10,
        color: colors.mutedForeground,
        fontWeight: '500',
        marginTop: spacing.xl,
    },
    welcomeContainer: {
        alignItems: 'center',
        paddingVertical: spacing.md,
    },
    welcomeSubtitle: {
        fontSize: typography.sizes.base,
        color: colors.mutedForeground,
        fontWeight: '500',
    },
    welcomeTitle: {
        fontSize: typography.sizes['2xl'],
        color: colors.foreground,
        fontWeight: '700',
        marginTop: spacing.xs,
    },
});
