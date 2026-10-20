import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Button, Input, Toast, ToastType, DebugCodeNotice } from '../../components/ui';
import { colors, spacing } from '../../theme';
import { verifyDeviceLogin, resendDeviceLoginCode } from '../../services/auth.service';
import { LogoIcon } from '../../components/LogoIcon';

/** Espera mínima entre códigos (igual que el límite del servidor) */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Login desde un dispositivo nuevo: no hay sesión hasta validar el código.
 * El servidor entrega la credencial y marca el dispositivo como de confianza.
 */
export default function VerifyDeviceScreen() {
    const router = useRouter();
    const params = useLocalSearchParams<{ email?: string; sent?: string; debug?: string }>();
    const email = typeof params.email === 'string' ? params.email : '';
    const codeSent = params.sent !== 'false';

    const [otp, setOtp] = useState('');
    // Solo en el entorno de pruebas con los códigos en pantalla activados
    const [debugCode, setDebugCode] = useState(typeof params.debug === 'string' ? params.debug : '');
    const [isLoading, setIsLoading] = useState(false);
    const [resending, setResending] = useState(false);
    const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);
    const [toast, setToast] = useState({ visible: false, message: '', type: 'info' as ToastType });

    const showToast = (message: string, type: ToastType = 'error') => setToast({ visible: true, message, type });

    // Sin email no hay nada que verificar: volver al login
    useEffect(() => {
        if (!email) router.replace('/(auth)/login');
    }, [email]);

    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setTimeout(() => setCooldown((s) => s - 1), 1000);
        return () => clearTimeout(timer);
    }, [cooldown]);

    const handleVerify = async () => {
        if (otp.length !== 6) {
            showToast('Ingresa el código de 6 dígitos');
            return;
        }

        setIsLoading(true);
        try {
            const result = await verifyDeviceLogin(email, otp);
            if (!result.success) {
                showToast(result.error || 'Código incorrecto');
                setOtp('');
                return;
            }
            // Sesión abierta: el layout lleva a la app al cargar el usuario
            router.replace('/(tabs)');
        } catch (error) {
            showToast('Ha ocurrido un error inesperado');
        } finally {
            setIsLoading(false);
        }
    };

    const handleResend = async () => {
        setResending(true);
        try {
            const res = await resendDeviceLoginCode(email);
            if (res.success) {
                showToast('Te enviamos un código nuevo', 'success');
                setOtp('');
                setDebugCode(res.debugCode ?? '');
                setCooldown(RESEND_COOLDOWN_SECONDS);
            } else if (res.loginAgain) {
                showToast(res.error || 'Vuelve a iniciar sesión');
                router.replace('/(auth)/login');
            } else {
                showToast(res.error || 'No se pudo reenviar el código');
            }
        } catch (error) {
            showToast('Error al reenviar');
        } finally {
            setResending(false);
        }
    };

    return (
        <SafeAreaView style={styles.container}>
            <Toast
                visible={toast.visible}
                message={toast.message}
                type={toast.type}
                onHide={() => setToast(prev => ({ ...prev, visible: false }))}
            />

            <KeyboardAvoidingView
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                style={styles.keyboardView}
            >
                <View style={styles.content}>
                    <View style={styles.header}>
                        <LogoIcon size={64} />
                        <Text style={styles.title}>Nuevo Dispositivo</Text>
                        <Text style={styles.subtitle}>
                            {codeSent
                                ? 'No reconocemos este dispositivo. Por tu seguridad, te enviamos un código de 6 dígitos a tu correo electrónico.'
                                : 'No reconocemos este dispositivo. Ingresa el código de 6 dígitos que te enviamos hace un momento a tu correo electrónico.'}
                        </Text>
                    </View>

                    <View style={styles.inputContainer}>
                        <DebugCodeNotice code={debugCode} />
                        <Input
                            label="Código de verificación"
                            value={otp}
                            onChangeText={(text) => setOtp(text.replace(/\D/g, ''))}
                            keyboardType="number-pad"
                            maxLength={6}
                            placeholder="000000"
                            icon={<Ionicons name="keypad-outline" size={20} color={colors.mutedForeground} />}
                        />
                    </View>

                    <View style={styles.actions}>
                        <Button
                            onPress={handleVerify}
                            loading={isLoading}
                            disabled={otp.length !== 6 || isLoading}
                            style={styles.button}
                        >
                            Verificar Dispositivo
                        </Button>
                        <Button
                            onPress={handleResend}
                            variant="ghost"
                            disabled={resending || cooldown > 0}
                            loading={resending}
                        >
                            {cooldown > 0 ? `Reenviar código en ${cooldown}s` : 'Reenviar código'}
                        </Button>
                        <Button onPress={() => router.replace('/(auth)/login')} variant="ghost">
                            Volver al inicio de sesión
                        </Button>
                    </View>
                </View>
            </KeyboardAvoidingView>
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
        flex: 1,
        padding: spacing.xl,
        justifyContent: 'center',
    },
    header: {
        alignItems: 'center',
        marginBottom: spacing['2xl'],
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.foreground,
        marginTop: spacing.lg,
        marginBottom: spacing.sm,
    },
    subtitle: {
        fontSize: 14,
        color: colors.mutedForeground,
        textAlign: 'center',
        lineHeight: 20,
        paddingHorizontal: spacing.md,
    },
    inputContainer: {
        marginBottom: spacing.xl,
    },
    actions: {
        gap: spacing.md,
    },
    button: {
        width: '100%',
    }
});
