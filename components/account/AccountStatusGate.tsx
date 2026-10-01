import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Button } from '../ui/Button';
import { colors, spacing, borderRadius } from '../../theme';
import { useAuth } from '../../context/AuthContext';
import { canOperate, isBusinessAccount } from '../../utils/user';

const pendingMessage = (isBusiness: boolean) =>
    isBusiness
        ? 'Estamos revisando los datos de tu empresa. Mientras tanto no puedes enviar ni recibir dinero. Te avisaremos por email cuando la cuenta esté aprobada.'
        : 'Estamos revisando tus datos. Mientras tanto no puedes enviar ni recibir dinero. Te avisaremos por email cuando la cuenta esté aprobada.';

/** Banner para el dashboard cuando la cuenta todavía no puede operar */
export const AccountStatusBanner: React.FC = () => {
    const { user } = useAuth();
    if (!user || canOperate(user)) return null;

    return (
        <View style={styles.banner}>
            <Ionicons name="time-outline" size={22} color={colors.warning} />
            <View style={{ flex: 1 }}>
                <Text style={styles.bannerTitle}>Tu cuenta está en revisión</Text>
                <Text style={styles.bannerText}>{pendingMessage(isBusinessAccount(user))}</Text>
            </View>
        </View>
    );
};

/** Pantalla que reemplaza a las operaciones de dinero mientras la cuenta no está verificada */
const AccountNotOperational: React.FC = () => {
    const insets = useSafeAreaInsets();
    const { user } = useAuth();

    return (
        <View style={[styles.screen, { paddingTop: insets.top + spacing.xl, paddingBottom: insets.bottom + 90 }]}>
            <View style={styles.iconCircle}>
                <Ionicons name="hourglass-outline" size={44} color={colors.warning} />
            </View>
            <Text style={styles.title}>Cuenta en revisión</Text>
            <Text style={styles.text}>{pendingMessage(isBusinessAccount(user))}</Text>
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
        const { user } = useAuth();
        if (user && !canOperate(user)) return <AccountNotOperational />;
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
