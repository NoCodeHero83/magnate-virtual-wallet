import React from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button } from '../ui/Button';
import { colors, spacing, borderRadius } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { getOperationalBlock, isBusinessAccount, OperationalBlock } from '../../utils/user';

const BLOCK_TITLES: Record<OperationalBlock, string> = {
    pending_review: 'Tu cuenta está en revisión',
    account_inactive: 'Tu cuenta no está habilitada',
};

const blockMessage = (block: OperationalBlock, isBusiness: boolean) => {
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
    return { block: getOperationalBlock(user, account), isBusiness: isBusinessAccount(user) };
};

/** Banner para el dashboard cuando la cuenta todavía no puede operar */
export const AccountStatusBanner: React.FC<{ style?: StyleProp<ViewStyle> }> = ({ style }) => {
    const { block, isBusiness } = useOperationalBlock();
    if (!block) return null;

    return (
        <View style={[styles.banner, style]}>
            <Ionicons
                name={block === 'pending_review' ? 'time-outline' : 'alert-circle-outline'}
                size={22}
                color={colors.warning}
            />
            <View style={{ flex: 1 }}>
                <Text style={styles.bannerTitle}>{BLOCK_TITLES[block]}</Text>
                <Text style={styles.bannerText}>{blockMessage(block, isBusiness)}</Text>
            </View>
        </View>
    );
};

/** Pantalla que reemplaza a las operaciones de dinero mientras la cuenta no está verificada */
const AccountNotOperational: React.FC<{ block: OperationalBlock; isBusiness: boolean }> = ({ block, isBusiness }) => {
    const insets = useSafeAreaInsets();

    return (
        <View style={[styles.screen, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + 90 }]}>
            <View style={styles.iconCircle}>
                <Ionicons
                    name={block === 'pending_review' ? 'hourglass-outline' : 'lock-closed-outline'}
                    size={44}
                    color={colors.warning}
                />
            </View>
            <Text style={styles.title}>{BLOCK_TITLES[block]}</Text>
            <Text style={styles.text}>{blockMessage(block, isBusiness)}</Text>
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
        const { block, isBusiness } = useOperationalBlock();
        if (block) return <AccountNotOperational block={block} isBusiness={isBusiness} />;
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
});
