import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button } from '../ui/Button';
import { colors, spacing, borderRadius } from '../../theme';
import { registerUser, CompanyRegisterData } from '../../services/auth.service';
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
    /** Volver a los datos sin perder lo cargado (incluida la firma de ZapSign) */
    onRetry: () => void;
}

export const StepConfirmation: React.FC<StepConfirmationProps> = ({ data, pin, accountType, company, onRetry }) => {
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
                    // Estado real con el que quedó la cuenta
                    setRequiresApproval(result.verificationStatus === 'pending');
                    setStatus('success');
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
                <Button variant="outline" onPress={onRetry} style={styles.button}>
                    Revisar mis datos
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
                        <Ionicons
                            name={accountType === 'business' ? 'business' : 'person'}
                            size={44}
                            color={colors.accent}
                        />
                    </View>
                </View>
                <View style={styles.successBadge}>
                    <Ionicons name="checkmark-circle" size={24} color={colors.success} />
                </View>
            </View>

            <Text style={styles.title}>¡Cuenta creada!</Text>
            <Text style={styles.subtitle}>Ya puedes iniciar sesión con tu email y tu PIN:</Text>

            <View style={styles.emailContainer}>
                <Text style={styles.emailText}>{data.email || 'tu@email.com'}</Text>
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
        marginTop: 0,
        marginBottom: spacing.xl,
    },
    reviewText: {
        flex: 1,
        fontSize: 13,
        lineHeight: 19,
        color: colors.foreground,
    },
});
