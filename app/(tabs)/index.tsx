import React, { useState, useCallback } from 'react';
import { View, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenHeader } from '../../components/layout';
import {
    BalanceCard,
    QuickActions,
    TransactionsList
} from '../../components/dashboard';
import { spacing } from '../../theme';
import { StatusBar } from 'expo-status-bar';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useAccount } from '../../hooks/useAccount';
import { AccountStatusBanner } from '../../components/account/AccountStatusGate';
import { getDisplayName } from '../../utils/user';

export default function DashboardScreen() {
    const { colors, isDark } = useTheme();
    const insets = useSafeAreaInsets();
    const { user, refreshUser } = useAuth();
    const { refreshBalance } = useAccount();
    const [refreshing, setRefreshing] = useState(false);

    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await Promise.all([refreshUser(), refreshBalance()]);
        setRefreshing(false);
    }, [refreshUser, refreshBalance]);

    return (
        <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
            <StatusBar style={isDark ? "light" : "dark"} />
            <ScrollView
                contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 90 }]}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        tintColor={colors.primary}
                        colors={[colors.primary]}
                    />
                }
            >
                <ScreenHeader
                    variant="dashboard"
                    userName={getDisplayName(user)}
                />

                <AccountStatusBanner />

                <View style={styles.section}>
                    <BalanceCard />
                </View>

                <QuickActions />

                <TransactionsList />

                {/* Padding final para scroll */}
                <View style={{ height: 80 }} />

            </ScrollView>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    scrollContent: {
        paddingBottom: spacing.xl,
    },
    section: {
        marginTop: spacing.md,
    },
});
