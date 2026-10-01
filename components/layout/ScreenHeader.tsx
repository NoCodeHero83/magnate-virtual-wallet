import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors as staticColors, spacing, typography, borderRadius } from '../../theme';
import { getDisplayName } from '../../utils/user';
import { Logo } from '../Logo';
import { Avatar } from '../ui';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';

interface ScreenHeaderProps {
    variant?: 'dashboard' | 'simple';
    title?: string;
    userName?: string;
    showBackButton?: boolean;
    showAvatar?: boolean;
    showMenu?: boolean;
    onBack?: () => void;
    centerTitle?: boolean;
}

export const ScreenHeader: React.FC<ScreenHeaderProps> = ({
    variant = 'simple',
    title,
    userName: userNameProp,
    showBackButton = false,
    showAvatar = true,
    showMenu = true,
    onBack,
    centerTitle = false,
}) => {
    const { colors } = useTheme();
    const { user, session } = useAuth();

    // Prioritize name from AuthContext user object, then prop, then default
    const fullName = user ? getDisplayName(user) : (userNameProp || "Usuario");
    const avatarUrl = user?.photo_url || session?.user?.user_metadata?.avatar_url;

    const handleBack = () => {
        if (onBack) {
            onBack();
            return;
        }
        if (router.canGoBack()) {
            router.back();
        } else {
            router.replace('/(tabs)');
        }
    };

    if (variant === 'dashboard') {
        return (
            <View style={[styles.container, { backgroundColor: colors.background }]}>
                {/* Top row: Logo + Actions */}
                <View style={styles.topRow}>
                    <Logo height={32} />

                    <View style={styles.actions}>
                        <TouchableOpacity onPress={() => router.push('/(tabs)/profile')}>
                            <Avatar name={fullName} image={avatarUrl} size={40} />
                        </TouchableOpacity>

                        <TouchableOpacity
                            style={styles.menuButton}
                            onPress={() => router.push('/menu')}
                        >
                            <Ionicons name="menu-outline" size={24} color={colors.foreground} />
                        </TouchableOpacity>
                    </View>
                </View>

                {/* Greeting + Badge */}
                <View style={styles.greetingContainer}>
                    <Text style={[styles.greetingText, { color: colors.foreground }]}>Hola, {fullName}</Text>
                    <View style={[styles.badge, { backgroundColor: colors.accentAlpha[10], borderColor: colors.accentAlpha[20] }]}>
                        <Ionicons name="finger-print" size={16} color={colors.accent} />
                        <Text style={[styles.badgeText, { color: colors.accent }]}>ACCESO PROTEGIDO</Text>
                    </View>
                </View>
            </View>
        );
    }

    // Simple Header (Movements, etc.)
    return (
        <View style={[styles.simpleContainer, { backgroundColor: colors.background }]}>
            {/* Si el título está centrado, lo posicionamos de forma absoluta */}
            {centerTitle && title && (
                <View style={styles.centeredTitleContainer}>
                    <Text style={[styles.headerTitleCentered, { color: colors.foreground }]} numberOfLines={1}>
                        {title}
                    </Text>
                </View>
            )}

            <View style={styles.leftContainer}>
                {showBackButton && (
                    <TouchableOpacity onPress={handleBack} style={styles.backButton}>
                        <Ionicons name="arrow-back" size={24} color={colors.foreground} />
                    </TouchableOpacity>
                )}

                {!centerTitle && title && (
                    <Text style={[styles.headerTitle, { color: colors.foreground }]} numberOfLines={1}>
                        {title}
                    </Text>
                )}
            </View>

            <View style={styles.actions}>
                {showAvatar && (
                    <TouchableOpacity onPress={() => router.push('/(tabs)/profile')}>
                        <Avatar name={fullName} image={avatarUrl} size={40} />
                    </TouchableOpacity>
                )}
                {showMenu && (
                    <TouchableOpacity
                        style={styles.menuButton}
                        onPress={() => router.push('/menu')}
                    >
                        <Ionicons name="menu-outline" size={24} color={colors.foreground} />
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    // Dashboard Styles
    container: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.lg, // Unificado
        paddingBottom: spacing.base,
    },
    topRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: spacing.lg,
        height: 48, // Altura fija
    },
    greetingContainer: {
        gap: spacing.sm,
    },
    greetingText: {
        fontSize: typography.sizes['3xl'],
        fontWeight: '700',
        letterSpacing: -0.5,
    },
    badge: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        paddingLeft: spacing.sm,
        paddingRight: spacing.md,
        paddingVertical: 4,
        borderRadius: borderRadius.full,
        borderWidth: 1,
    },
    badgeText: {
        fontSize: 10,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },

    // Simple Header Styles
    simpleContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.lg, // Unificado
        paddingBottom: spacing.md,
        height: 48 + spacing.lg + spacing.md, // Altura total consistente si se requiere (opcional)
    },
    leftContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        flex: 1,
        height: 48, // Altura fija
    },
    backButton: {
        padding: 4,
        marginLeft: -4,
    },
    headerTitle: {
        fontSize: typography.sizes.xl,
        lineHeight: 32, // Match Logo height
        fontWeight: '700',
    },
    centeredTitleContainer: {
        position: 'absolute',
        top: spacing.lg,
        left: 0,
        right: 0,
        bottom: spacing.md,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 0,
    },
    headerTitleCentered: {
        fontSize: typography.sizes.xl,
        fontWeight: '700',
        textAlign: 'center',
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        zIndex: 1,
    },
    menuButton: {
        padding: 4,
    },
});
