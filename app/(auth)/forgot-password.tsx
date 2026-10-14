import React, { useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    KeyboardAvoidingView,
    Platform,
    TouchableOpacity,
    ActivityIndicator,
    ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ScreenHeader } from '../../components/layout';
import { FormInput } from '../../components/register/FormInput';
import { Button } from '../../components/ui/Button';
import { Toast } from '../../components/ui';
import { PIN_LENGTH } from '../../constants/app';
import { requestPinReset, confirmPinReset } from '../../services/auth.service';
import { colors, spacing, borderRadius } from '../../theme';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const onlyDigits = (value: string, max: number) => value.replace(/\D/g, '').slice(0, max);

export default function ForgotPasswordScreen() {
    const params = useLocalSearchParams<{ email?: string }>();
    const [email, setEmail] = useState(typeof params.email === 'string' ? params.email : '');
    const [step, setStep] = useState<'email' | 'reset' | 'done'>('email');
    const [code, setCode] = useState('');
    const [newPin, setNewPin] = useState('');
    const [confirmPin, setConfirmPin] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [toast, setToast] = useState<{ visible: boolean; message: string; type: 'success' | 'error' }>({
        visible: false,
        message: '',
        type: 'error',
    });

    const showToast = (message: string, type: 'success' | 'error' = 'error') => {
        setToast({ visible: true, message, type });
    };

    const emailValid = EMAIL_REGEX.test(email.trim());
    const pinsMatch = newPin === confirmPin;
    const canConfirm =
        code.length === 6 && newPin.length === PIN_LENGTH && confirmPin.length === PIN_LENGTH && pinsMatch;

    const handleSendCode = async () => {
        if (!emailValid || isLoading) return;
        setIsLoading(true);
        const result = await requestPinReset(email);
        setIsLoading(false);
        if (!result.success) {
            showToast(result.error || 'No se pudo enviar el código');
            return;
        }
        setCode('');
        setNewPin('');
        setConfirmPin('');
        setStep('reset');
    };

    const handleResend = async () => {
        if (isLoading) return;
        setIsLoading(true);
        const result = await requestPinReset(email);
        setIsLoading(false);
        if (result.success) showToast('Si el correo está registrado, te enviamos un código nuevo.', 'success');
        else showToast(result.error || 'No se pudo enviar el código');
    };

    const handleConfirm = async () => {
        if (!canConfirm || isLoading) return;
        setIsLoading(true);
        const result = await confirmPinReset(email, code, newPin);
        setIsLoading(false);
        if (result.success) {
            setStep('done');
            return;
        }
        showToast(result.error || 'No se pudo cambiar el PIN');
        if (result.code === 'INVALID_CODE') {
            setCode('');
        } else if (result.code === 'INVALID_NEW_PIN') {
            setNewPin('');
            setConfirmPin('');
        } else if (result.code === 'CODE_EXPIRED' || result.code === 'TOO_MANY_ATTEMPTS') {
            setCode('');
            setStep('email');
        }
    };

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            <ScreenHeader
                title="Recuperar PIN"
                showBackButton={step !== 'done'}
                showAvatar={false}
                showMenu={false}
                centerTitle={step !== 'email'}
                onBack={() => (step === 'reset' ? setStep('email') : router.back())}
            />

            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardView}
            >
                <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                    {step === 'email' && (
                        <View style={styles.formContainer}>
                            <View style={styles.iconContainer}>
                                <Ionicons name="key-outline" size={40} color={colors.accent} />
                            </View>

                            <Text style={styles.title}>¿Olvidaste tu PIN?</Text>
                            <Text style={styles.subtitle}>
                                Ingresa el correo de tu cuenta y te enviaremos un código para crear un PIN nuevo.
                            </Text>

                            <FormInput
                                label="Correo Electrónico"
                                placeholder="ejemplo@magnate.com"
                                value={email}
                                onChangeText={setEmail}
                                keyboardType="email-address"
                                autoCapitalize="none"
                                autoCorrect={false}
                                icon="mail-outline"
                                containerStyle={styles.fullWidth}
                            />

                            <Button
                                onPress={handleSendCode}
                                disabled={isLoading || !emailValid}
                                loading={isLoading}
                                style={styles.submitButton}
                            >
                                Enviar código
                            </Button>

                            <TouchableOpacity onPress={() => router.back()} style={styles.linkButton}>
                                <Text style={styles.linkText}>Volver al inicio de sesión</Text>
                            </TouchableOpacity>
                        </View>
                    )}

                    {step === 'reset' && (
                        <View style={styles.formContainer}>
                            <View style={styles.iconContainer}>
                                <Ionicons name="mail-open-outline" size={40} color={colors.accent} />
                            </View>

                            <Text style={styles.title}>Revisa tu correo</Text>
                            <Text style={styles.subtitle}>
                                Si el correo está registrado, te enviamos un código de 6 dígitos a
                            </Text>
                            <View style={styles.emailBadge}>
                                <Text style={styles.emailBadgeText}>{email.trim()}</Text>
                            </View>

                            <FormInput
                                label="Código"
                                placeholder="000000"
                                value={code}
                                onChangeText={(t) => setCode(onlyDigits(t, 6))}
                                keyboardType="number-pad"
                                textContentType="oneTimeCode"
                                autoComplete="one-time-code"
                                maxLength={6}
                                icon="keypad-outline"
                                containerStyle={styles.fullWidth}
                            />
                            <FormInput
                                label={`Nuevo PIN (${PIN_LENGTH} dígitos)`}
                                placeholder="••••••"
                                value={newPin}
                                onChangeText={(t) => setNewPin(onlyDigits(t, PIN_LENGTH))}
                                keyboardType="number-pad"
                                secureTextEntry
                                maxLength={PIN_LENGTH}
                                icon="lock-closed-outline"
                                containerStyle={styles.fullWidth}
                            />
                            <FormInput
                                label="Repetir PIN"
                                placeholder="••••••"
                                value={confirmPin}
                                onChangeText={(t) => setConfirmPin(onlyDigits(t, PIN_LENGTH))}
                                keyboardType="number-pad"
                                secureTextEntry
                                maxLength={PIN_LENGTH}
                                icon="lock-closed-outline"
                                containerStyle={styles.fullWidth}
                                error={confirmPin.length === PIN_LENGTH && !pinsMatch ? 'Los PIN no coinciden' : undefined}
                            />

                            <Button
                                onPress={handleConfirm}
                                disabled={isLoading || !canConfirm}
                                loading={isLoading}
                                style={styles.submitButton}
                            >
                                Cambiar PIN
                            </Button>

                            <TouchableOpacity onPress={handleResend} disabled={isLoading} style={styles.linkButton}>
                                <Text style={styles.linkText}>¿No te llegó? Reenviar código</Text>
                            </TouchableOpacity>
                            <Text style={styles.infoText}>
                                Revisa también la carpeta de spam. El código vence en 10 minutos.
                            </Text>
                        </View>
                    )}

                    {step === 'done' && (
                        <View style={styles.successContainer}>
                            <View style={styles.successIconContainer}>
                                <View style={styles.successPulse}>
                                    <View style={styles.successCircle}>
                                        <Ionicons name="checkmark-circle-outline" size={44} color={colors.success} />
                                    </View>
                                </View>
                            </View>

                            <Text style={styles.title}>¡PIN actualizado!</Text>
                            <Text style={styles.subtitle}>
                                Ya puedes ingresar con tu nuevo PIN. Por seguridad, cerramos las sesiones abiertas.
                            </Text>

                            <Button onPress={() => router.replace('/(auth)/login')} style={styles.submitButton}>
                                Ir al Login
                            </Button>
                        </View>
                    )}
                </ScrollView>

                {isLoading && (
                    <View style={styles.loadingOverlay} pointerEvents="none">
                        <ActivityIndicator size="large" color={colors.accent} />
                    </View>
                )}
            </KeyboardAvoidingView>

            <Toast
                visible={toast.visible}
                message={toast.message}
                type={toast.type}
                onHide={() => setToast((prev) => ({ ...prev, visible: false }))}
            />
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    keyboardView: {
        flex: 1,
    },
    content: {
        flexGrow: 1,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.xl,
        paddingBottom: spacing.xl,
    },
    formContainer: {
        flex: 1,
        alignItems: 'center',
    },
    fullWidth: {
        width: '100%',
    },
    iconContainer: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: colors.accentAlpha[10],
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: spacing.lg,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        color: colors.foreground,
        textAlign: 'center',
        marginBottom: spacing.sm,
    },
    subtitle: {
        fontSize: 14,
        color: colors.mutedForeground,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: spacing.xl,
    },
    submitButton: {
        width: '100%',
        height: 56,
        marginTop: spacing.lg,
    },
    linkButton: {
        marginTop: spacing.xl,
    },
    linkText: {
        fontSize: 14,
        color: colors.mutedForeground,
        fontWeight: '500',
    },
    successContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    successIconContainer: {
        marginBottom: spacing.xl,
    },
    successPulse: {
        width: 120,
        height: 120,
        borderRadius: 60,
        backgroundColor: colors.successAlpha[5],
        justifyContent: 'center',
        alignItems: 'center',
    },
    successCircle: {
        width: 90,
        height: 90,
        borderRadius: 45,
        backgroundColor: colors.successAlpha[10],
        justifyContent: 'center',
        alignItems: 'center',
    },
    emailBadge: {
        backgroundColor: colors.accentAlpha[10],
        paddingHorizontal: spacing.base,
        paddingVertical: 8,
        borderRadius: borderRadius.md,
        marginTop: -spacing.lg,
        marginBottom: spacing.xl,
    },
    emailBadgeText: {
        color: colors.accent,
        fontWeight: '600',
        fontSize: 14,
    },
    infoText: {
        fontSize: 12,
        color: colors.mutedForeground,
        textAlign: 'center',
        lineHeight: 18,
        marginTop: spacing.md,
        marginHorizontal: spacing.xl,
    },
    loadingOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0,0,0,0.3)',
        justifyContent: 'center',
        alignItems: 'center',
    },
});
