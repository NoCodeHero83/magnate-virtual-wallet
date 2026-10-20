import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button } from '../ui/Button';
import { colors, spacing, borderRadius } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { getOperationalBlock, isBusinessAccount, OperationalBlock } from '../../utils/user';

const BLOCK_TITLES: Record<OperationalBlock, string> = {
    pending_review: 'Tu cuenta está en revisión',
    rejected: 'Tu cuenta fue rechazada',
    account_inactive: 'Tu cuenta no está habilitada',
};

const blockMessage = (block: OperationalBlock, isBusiness: boolean, reason?: string | null) => {
    if (block === 'rejected') {
        const detail = reason ? `Motivo: ${reason}. ` : '';
        return isBusiness
            ? `${detail}Corrige los documentos observados y vuelve a subirlos: la cuenta vuelve a revisión automáticamente. Mientras tanto no puedes enviar ni recibir dinero.`
            : `${detail}No puedes enviar ni recibir dinero. Si crees que es un error, contacta a soporte.`;
    }
    if (block === 'account_inactive') {
        return 'Tu cuenta no está habilitada para enviar ni recibir dinero en este momento. Contacta a soporte para más información.';
    }
    return isBusiness
        ? 'Estamos revisando los datos de tu empresa. Mientras tanto no puedes enviar ni recibir dinero. Te avisaremos por email cuando la cuenta esté aprobada.'
        : 'Estamos revisando tus datos. Mientras tanto no puedes enviar ni recibir dinero. Te avisaremos por email cuando la cuenta esté aprobada.';
};

/** Motivo de bloqueo del usuario actual (null si puede operar) */
const useOperationalBlock = () => {
    const { user, account } = useAuth();
    return {
        block: getOperationalBlock(user, account),
        isBusiness: isBusinessAccount(user),
        reason: user?.status_reason ?? null,
    };
};

const BLOCK_COLORS: Record<OperationalBlock, { color: string; alpha: Record<number, string> }> = {
    pending_review: { color: colors.warning, alpha: colors.warningAlpha },
    rejected: { color: colors.destructive, alpha: colors.destructiveAlpha },
    account_inactive: { color: colors.warning, alpha: colors.warningAlpha },
};

const BANNER_ICONS: Record<OperationalBlock, keyof typeof Ionicons.glyphMap> = {
    pending_review: 'time-outline',
    rejected: 'close-circle-outline',
    account_inactive: 'alert-circle-outline',
};

/** Banner para el dashboard cuando la cuenta todavía no puede operar */
export const AccountStatusBanner: React.FC<{ style?: StyleProp<ViewStyle> }> = ({ style }) => {
    const { block, isBusiness, reason } = useOperationalBlock();
    if (!block) return null;
    const tone = BLOCK_COLORS[block];

    return (
        <View style={[styles.banner, { backgroundColor: tone.alpha[10], borderColor: tone.alpha[40] }, style]}>
            <Ionicons name={BANNER_ICONS[block]} size={22} color={tone.color} />
            <View style={{ flex: 1 }}>
                <Text style={styles.bannerTitle}>{BLOCK_TITLES[block]}</Text>
                <Text style={styles.bannerText}>{blockMessage(block, isBusiness, reason)}</Text>
                {block !== 'account_inactive' && isBusiness && (
                    <TouchableOpacity
                        onPress={() => router.push('/profile/company-documents')}
                        style={styles.bannerLink}
                        accessibilityRole="link"
                    >
                        <Text style={styles.bannerLinkText}>
                            {block === 'rejected' ? 'Corregir documentación' : 'Subir documentación de la empresa'}
                        </Text>
                        <Ionicons name="chevron-forward" size={14} color={colors.accent} />
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
};

/** Pantalla que reemplaza a las operaciones de dinero mientras la cuenta no está verificada */
const AccountNotOperational: React.FC<{ block: OperationalBlock; isBusiness: boolean; reason: string | null }> = ({
    block,
    isBusiness,
    reason,
}) => {
    const insets = useSafeAreaInsets();
    const tone = BLOCK_COLORS[block];

    return (
        <View style={[styles.screen, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + 90 }]}>
            <View style={[styles.iconCircle, { backgroundColor: tone.alpha[10] }]}>
                <Ionicons
                    name={block === 'pending_review' ? 'hourglass-outline' : block === 'rejected' ? 'close-circle-outline' : 'lock-closed-outline'}
                    size={44}
                    color={tone.color}
                />
            </View>
            <Text style={styles.title}>{BLOCK_TITLES[block]}</Text>
            <Text style={styles.text}>{blockMessage(block, isBusiness, reason)}</Text>
            {block === 'rejected' && isBusiness && (
                <Button onPress={() => router.push('/profile/company-documents')} style={styles.buttonSpaced}>
                    Corregir documentación
                </Button>
            )}
            <Button onPress={() => router.replace('/(tabs)')} style={styles.button}>
                Volver al inicio
            </Button>
        </View>
    );
};

/**
 * Envuelve una pantalla que mueve dinero (transferir, pagar, cobrar, API):
 * si la cuenta no está verificada muestra el aviso en lugar de la pantalla.
 * El bloqueo real lo hace la base de datos (la cuenta queda 'blocked').
 */
export function withOperationalAccount<P extends object>(Screen: React.ComponentType<P>) {
    const Gated = (props: P) => {
        const { block, isBusiness, reason } = useOperationalBlock();
        if (block) return <AccountNotOperational block={block} isBusiness={isBusiness} reason={reason} />;
        return <Screen {...props} />;
    };
    Gated.displayName = `withOperationalAccount(${Screen.displayName || Screen.name || 'Screen'})`;
    return Gated;
}

const styles = StyleSheet.create({
    banner: {
        flexDirection: 'row',
        gap: spacing.sm,
        marginHorizontal: spacing.lg,
        marginTop: spacing.md,
        padding: spacing.md,
        borderRadius: borderRadius.xl,
        backgroundColor: colors.warningAlpha[10],
        borderWidth: 1,
        borderColor: colors.warningAlpha[40],
    },
    bannerTitle: {
        fontSize: 14,
        fontWeight: '700',
        color: colors.foreground,
        marginBottom: 2,
    },
    bannerLink: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 2,
        marginTop: spacing.sm,
    },
    bannerLinkText: {
        fontSize: 13,
        fontWeight: '600',
        color: colors.accent,
    },
    bannerText: {
        fontSize: 13,
        lineHeight: 18,
        color: colors.mutedForeground,
    },
    screen: {
        flex: 1,
        backgroundColor: colors.background,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: spacing.lg,
    },
    iconCircle: {
        width: 96,
        height: 96,
        borderRadius: 48,
        backgroundColor: colors.warningAlpha[10],
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: spacing.lg,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.foreground,
        marginBottom: spacing.sm,
        textAlign: 'center',
    },
    text: {
        fontSize: 14,
        lineHeight: 20,
        color: colors.mutedForeground,
        textAlign: 'center',
        marginBottom: spacing.xl,
    },
    button: {
        width: '100%',
        height: 56,
    },
    buttonSpaced: {
        width: '100%',
        height: 56,
        marginBottom: spacing.md,
    },
});
