import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button } from '../ui/Button';
import { colors, spacing, borderRadius, typography } from '../../theme';
import { registerUser, CompanyRegisterData } from '../../services/auth.service';
import { supabase } from '../../lib/supabase';
import type { UserAccountType } from '../../types/database.types';

interface StepConfirmationProps {
    data: {
        nombres: string;
        apellidos: string;
        email: string;
        telefono: string;
        dni: string;
        cuit: string;
        zapsign_doc_token?: string;
        zapsign_data?: any;
    };
    pin: string;
    accountType: UserAccountType;
    company?: CompanyRegisterData;
}

export const StepConfirmation: React.FC<StepConfirmationProps> = ({ data, pin, accountType, company }) => {
    const insets = useSafeAreaInsets();
    const [status, setStatus] = useState<'processing' | 'success' | 'error'>('processing');
    const [errorMsg, setErrorMsg] = useState('');
    const [requiresApproval, setRequiresApproval] = useState(false);

    useEffect(() => {
        const performRegistration = async () => {
            try {
                const result = await registerUser({
                    ...data,
                    pin,
                    account_type: accountType,
                    company,
                });

                if (result.success) {
                    // Avisar si la cuenta queda en revisión (según la configuración del admin)
                    const { data: needsApproval } = await supabase.rpc('signup_requires_approval', {
                        p_account_type: accountType,
                    } as any);
                    setRequiresApproval(needsApproval === true);
                    setStatus('success');
                    // En este punto no realizamos auto-login: forzamos verificación de email en todos los entornos
                } else {
                    setStatus('error');
                    setErrorMsg(result.error || 'Error al procesar el registro');
                }
            } catch (err: any) {
                setStatus('error');
                setErrorMsg(err.message || 'Error inesperado');
            }
        };

        performRegistration();
    }, []);

    if (status === 'processing') {
        return (
            <View style={[styles.container, { paddingBottom: spacing.xl + insets.bottom }]}>
                <View style={styles.loadingBox}>
                    <ActivityIndicator size="large" color={colors.accent} />
                    <Text style={styles.processingTitle}>Procesando tu registro</Text>
                    <Text style={styles.processingSubtitle}>Estamos configurando tu cuenta de Magnate...</Text>
                </View>
            </View>
        );
    }

    if (status === 'error') {
        return (
            <View style={[styles.container, { paddingBottom: spacing.xl + insets.bottom }]}>
                <View style={[styles.iconCircle, { backgroundColor: colors.destructiveAlpha[10] }]}>
                    <Ionicons name="alert-circle" size={50} color={colors.destructive} />
                </View>
                <Text style={styles.title}>Hubo un problema</Text>
                <Text style={styles.subtitle}>{errorMsg}</Text>
                <Button
                    variant="outline"
                    onPress={() => router.replace('/(auth)/register')}
                    style={styles.button}
                >
                    Volver a intentar
                </Button>
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingBottom: spacing.xl + insets.bottom }]}>
            {/* Icon Stack */}
            <View style={styles.iconStack}>
                <View style={styles.pulseBg}>
                    <View style={styles.iconCircle}>
                        <Ionicons name="mail" size={44} color={colors.accent} />
                    </View>
                </View>
                <View style={styles.successBadge}>
                    <Ionicons name="checkmark-circle" size={24} color={colors.success} />
                </View>
            </View>

            <Text style={styles.title}>¡Casi listo!</Text>
            <Text style={styles.subtitle}>Enviamos un enlace de verificación a tu correo:</Text>

            <View style={styles.emailContainer}>
                <Text style={styles.emailText}>{data.email || 'tu@email.com'}</Text>
            </View>

            <View style={styles.nextStepBox}>
                <View style={styles.nextStepHeader}>
                    <View style={styles.infoBadge}>
                        <Text style={styles.infoText}>!</Text>
                    </View>
                    <Text style={styles.nextStepTitle}>Próximo paso</Text>
                </View>
                <Text style={styles.nextStepDesc}>
                    Por favor, confirma tu email para activar todas las funciones de tu billetera Magnate.
                    Revisa tu bandeja de entrada y haz clic en el enlace de verificación.
                </Text>
            </View>

            {requiresApproval && (
                <View style={styles.reviewBox}>
                    <Ionicons name="time-outline" size={22} color={colors.warning} />
                    <Text style={styles.reviewText}>
                        {accountType === 'business'
                            ? 'Revisaremos los datos de tu empresa. Podrás ingresar a la app, pero no podrás enviar ni recibir dinero hasta que tu cuenta sea aprobada. Te avisaremos por email.'
                            : 'Revisaremos tus datos. Podrás ingresar a la app, pero no podrás enviar ni recibir dinero hasta que tu cuenta sea aprobada. Te avisaremos por email.'}
                    </Text>
                </View>
            )}

            <Button
                onPress={() => router.replace('/(auth)/login')}
                style={styles.button}
            >
                Ir al Login
                <Ionicons name="arrow-forward" size={20} color={colors.accentForeground} style={{ marginLeft: 8 }} />
            </Button>

            <View style={styles.footer}>
                <Text style={styles.footerText}>¿No recibiste el correo? </Text>
                <TouchableOpacity
                    onPress={async () => {
                        try {
                            const res = await supabase.auth.resend({
                                type: 'signup',
                                email: data.email
                            } as any);
                            Alert.alert('Verificación', 'Correo de verificación reenviado.');
                        } catch (e: any) {
                            Alert.alert('Error', 'No se pudo reenviar el correo de verificación.');
                        }
                    }}
                >
                    <Text style={styles.resendLink}>reenviar verificación</Text>
                </TouchableOpacity>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.xl,
        alignItems: 'center',
        justifyContent: 'center',
        flex: 1,
    },
    loadingBox: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.md,
    },
    processingTitle: {
        fontSize: 20,
        fontWeight: '700',
        color: colors.foreground,
        marginTop: spacing.md,
    },
    processingSubtitle: {
        fontSize: 14,
        color: colors.mutedForeground,
        textAlign: 'center',
        paddingHorizontal: spacing.xl,
    },
    iconStack: {
        position: 'relative',
        marginBottom: spacing.xl,
    },
    pulseBg: {
        width: 130,
        height: 130,
        borderRadius: 65,
        backgroundColor: colors.accentAlpha[5],
        justifyContent: 'center',
        alignItems: 'center',
    },
    iconCircle: {
        width: 100,
        height: 100,
        borderRadius: 50,
        backgroundColor: colors.accentAlpha[10],
        justifyContent: 'center',
        alignItems: 'center',
    },
    successBadge: {
        position: 'absolute',
        bottom: 0,
        right: 0,
        backgroundColor: colors.background,
        borderRadius: 15,
        padding: 2,
    },
    title: {
        fontSize: 26,
        fontWeight: 'bold',
        color: colors.foreground,
        marginBottom: spacing.sm,
        textAlign: 'center',
    },
    subtitle: {
        fontSize: 14,
        color: colors.mutedForeground,
        textAlign: 'center',
        marginBottom: spacing.md,
    },
    emailContainer: {
        backgroundColor: colors.accentAlpha[10],
        paddingHorizontal: spacing.md,
        paddingVertical: 8,
        borderRadius: borderRadius.md,
        marginBottom: spacing.xl,
    },
    emailText: {
        color: colors.accent,
        fontWeight: '600',
        fontSize: 14,
    },
    nextStepBox: {
        backgroundColor: colors.card,
        padding: spacing.lg,
        borderRadius: borderRadius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        width: '100%',
        marginBottom: spacing.xl,
    },
    nextStepHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        marginBottom: spacing.sm,
    },
    infoBadge: {
        width: 24,
        height: 24,
        borderRadius: 12,
        backgroundColor: colors.accent,
        justifyContent: 'center',
        alignItems: 'center',
    },
    infoText: {
        color: colors.accentForeground,
        fontWeight: 'bold',
        fontSize: 12,
    },
    nextStepTitle: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.foreground,
    },
    nextStepDesc: {
        fontSize: 13,
        color: colors.mutedForeground,
        lineHeight: 20,
    },
    button: {
        width: '100%',
        height: 56,
    },
    reviewBox: {
        flexDirection: 'row',
        gap: spacing.sm,
        backgroundColor: colors.warningAlpha[10],
        borderWidth: 1,
        borderColor: colors.warningAlpha[40],
        borderRadius: borderRadius.xl,
        padding: spacing.md,
        width: '100%',
        marginTop: -spacing.md,
        marginBottom: spacing.xl,
    },
    reviewText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 19,
        color: colors.foreground,
    },
    footer: {
        flexDirection: 'row',
        marginTop: spacing.xl,
        alignItems: 'center',
    },
    footerText: {
        fontSize: 12,
        color: colors.mutedForeground,
    },
    resendLink: {
        fontSize: 12,
        color: colors.accent,
        fontWeight: '600',
    }
});
