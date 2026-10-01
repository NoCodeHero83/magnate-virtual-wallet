import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, borderRadius } from '../../theme';
import { getDisplayName } from '../../utils/user';
import { Logo } from '../Logo';
import { Avatar } from '../ui';

import { useAuth } from '../../context/AuthContext';

interface DashboardHeaderProps {
    userName?: string;
}

export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
    userName: userNameProp
}) => {
    const { user, session } = useAuth();
    const fullName = user ? getDisplayName(user) : (userNameProp || "Usuario");
    const avatarUrl = user?.photo_url || session?.user?.user_metadata?.avatar_url;
    return (
        <View style={styles.container}>
            {/* Top row: Logo + Actions */}
            <View style={styles.topRow}>
                <Logo height={32} />

                <View style={styles.actions}>
                    <TouchableOpacity>
                        <Avatar name={fullName} image={avatarUrl} size={40} />
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.menuButton}>
                        <Ionicons name="menu-outline" size={24} color={colors.foreground} />
                    </TouchableOpacity>
                </View>
            </View>

            {/* Greeting + Badge */}
            <View style={styles.greetingContainer}>
                <Text style={styles.greetingText}>Hola, {fullName}</Text>

                <View style={styles.badge}>
                    <Ionicons name="finger-print" size={16} color={colors.accent} />
                    <Text style={styles.badgeText}>ACCESO PROTEGIDO</Text>
                </View>
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.base,
        paddingBottom: spacing.base,
    },
    topRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: spacing.lg,
    },
    actions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
    },
    menuButton: {
        padding: 4,
    },
    avatarButton: {
        // Web: group relative outline-none
    },
    avatarPlaceholder: {
        width: 40,
        height: 40,
        borderRadius: borderRadius.full,
        backgroundColor: colors.muted,
        borderColor: 'rgba(47, 128, 237, 0.2)', // accent/20
        borderWidth: 2,
        // Mobile doesn't have hover, but we simulate structure
    },
    greetingContainer: {
        gap: spacing.sm,
    },
    greetingText: {
        fontSize: typography.sizes['3xl'],
        fontWeight: '700',
        color: colors.foreground,
        letterSpacing: -0.5,
    },
    badge: {
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
        backgroundColor: 'rgba(47, 128, 237, 0.1)', // accent/10
        paddingLeft: spacing.sm,
        paddingRight: spacing.md,
        paddingVertical: 4,
        borderRadius: borderRadius.full,
        borderWidth: 1,
        borderColor: 'rgba(47, 128, 237, 0.2)', // accent/20
    },
    badgeText: {
        color: colors.accent,
        fontSize: 10,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
});
