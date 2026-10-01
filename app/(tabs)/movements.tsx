import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, SectionList, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { StatusBar } from 'expo-status-bar';

import { spacing, typography, borderRadius } from '../../theme';
import { ScreenHeader } from '../../components/layout';
import { SearchBar, FilterChips, FilterType, DateRangeFilter } from '../../components/movements';
import { TransactionItem } from '../../components/dashboard';
import { TransactionDetailModal } from '../../components/dashboard';
import { formatBalance } from '../../utils/formatters';
import { getDisplayName } from '../../utils/user';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { transactionService } from '../../services/transaction.service';
import { statementService } from '../../services/statement.service';

export default function MovementsScreen() {
    const { colors, isDark } = useTheme();
    const insets = useSafeAreaInsets();
    const { account, user } = useAuth();
    const [activeFilter, setActiveFilter] = useState<FilterType>('todos');
    const [searchQuery, setSearchQuery] = useState('');
    const [showBalance, setShowBalance] = useState(true);
    const [isLoading, setIsLoading] = useState(true);
    const [isDownloading, setIsDownloading] = useState(false);
    const [transactions, setTransactions] = useState<any[]>([]);
    const [selectedTransaction, setSelectedTransaction] = useState<any | null>(null);

    const [showDateFilter, setShowDateFilter] = useState(false);
    const [dateRange, setDateRange] = useState<{ from: Date; to: Date } | null>(null);

    const styles = useMemo(() => createStyles(colors), [colors]);

    React.useEffect(() => {
        loadMovements();
    }, [account, activeFilter, dateRange]);

    const loadMovements = async () => {
        if (!account) return;
        setIsLoading(true);
        try {
            const filters: any = {};
            if (activeFilter === 'ingresos') filters.type = 'income';
            if (activeFilter === 'egresos') filters.type = 'expense';
            if (dateRange) {
                filters.startDate = dateRange.from;
                filters.endDate = dateRange.to;
            }

            const data = await transactionService.getAccountMovements(account.id, 50, 0, filters);
            setTransactions(data);
        } catch (error) {
            console.error(error);
        } finally {
            setIsLoading(false);
        }
    };

    const handleFilterChange = (filter: FilterType) => {
        if (filter === 'fechas') {
            setShowDateFilter(true);
        } else {
            setActiveFilter(filter);
            setDateRange(null);
        }
    };

    const applyDateFilter = (range: { from: Date; to: Date }) => {
        setDateRange(range);
        setActiveFilter('fechas');
        setShowDateFilter(false);
    };

    const handleDownloadStatement = async () => {
        if (!account) return;
        setIsDownloading(true);
        try {
            const filters: { type?: 'income' | 'expense'; startDate?: Date; endDate?: Date } = {};
            if (activeFilter === 'ingresos') filters.type = 'income';
            if (activeFilter === 'egresos') filters.type = 'expense';
            if (dateRange) {
                filters.startDate = dateRange.from;
                filters.endDate = dateRange.to;
            }

            const result = await statementService.generateAndShare({
                accountId: account.id,
                // Estado de cuenta: razón social para empresas
                accountHolderName: user?.account_type === 'business' && user.business_profile ? user.business_profile.legal_name : getDisplayName(user),
                balance: account.balance,
                filters,
            });

            Alert.alert(
                'Estado de cuenta',
                `PDF generado con ${result.count} movimientos.\n\nIngresos: ${formatBalance(result.income)}\nEgresos: ${formatBalance(result.expense)}`,
            );
        } catch (error: any) {
            console.error('Error generando estado de cuenta:', error);
            Alert.alert(
                'Error',
                error?.message || 'No se pudo generar el estado de cuenta. Intente nuevamente.',
            );
        } finally {
            setIsDownloading(false);
        }
    };

    // Procesar datos para la lista (agrupar y filtrar por búsqueda localmente por ahora)
    const sections = useMemo(() => {
        // 1. Filtrar por búsqueda
        let data = transactions;
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            data = data.filter(t => {
                const concept = (t.concept || t.transaction_type_name || '').toLowerCase();
                const amount = t.amount.toString();
                return concept.includes(query) || amount.includes(query);
            });
        }

        // 2. Agrupar por fecha
        const groups: Record<string, any[]> = {};

        data.forEach(t => {
            const date = new Date(t.created_at);
            const today = new Date();
            let dateKey = "";

            if (date.toDateString() === today.toDateString()) {
                dateKey = "Hoy";
            } else {
                // Format: "24 Oct"
                const day = date.getDate();
                const month = date.toLocaleString('es-ES', { month: 'short' });
                dateKey = `${day} ${month.charAt(0).toUpperCase() + month.slice(1)}`;
            }

            if (!groups[dateKey]) {
                groups[dateKey] = [];
            }

            // Map to TransactionItem props
            groups[dateKey].push({
                id: t.transaction_id,
                title: t.counterpart_name || t.transaction_type_name,
                description: t.concept || t.transaction_type_name,
                amount: formatBalance(t.amount),
                type: t.movement_type === 'income' ? 'income' : 'expense',
                iconName: t.movement_type === 'income' ? 'arrow-down' : 'arrow-up',
                date: t.created_at
            });
        });

        const result: { title: string, data: any[] }[] = [];
        Object.keys(groups).forEach(date => {
            result.push({ title: date, data: groups[date] });
        });

        // Sort by date desc (though object keys might not preserve order appropriately, list is already sorted by date desc)
        // Better to iterate the original list to maintain order of groups?
        // Simple approach: we rely on data being sorted by date, so we can build sections linearly.

        const linearSections: { title: string, data: any[] }[] = [];
        let currentSection: { title: string, data: any[] } | null = null;

        data.forEach(t => {
            const date = new Date(t.created_at);
            const today = new Date();
            let dateKey = "";

            if (date.toDateString() === today.toDateString()) {
                dateKey = "Hoy";
            } else {
                const day = date.getDate();
                const month = date.toLocaleString('es-ES', { month: 'short' });
                dateKey = `${day} ${month.charAt(0).toUpperCase() + month.slice(1)}`;
            }

            if (!currentSection || currentSection.title !== dateKey) {
                currentSection = { title: dateKey, data: [] };
                linearSections.push(currentSection);
            }

            currentSection.data.push({
                id: t.transaction_id,
                title: t.counterpart_name || t.transaction_type_name,
                description: t.concept || t.transaction_type_name,
                amount: formatBalance(t.amount),
                type: t.movement_type === 'income' ? 'income' : 'expense',
                iconName: t.movement_type === 'income' ? 'arrow-down' : 'arrow-up',
                date: t.created_at,
                transaction: t
            });
        });

        return linearSections;

    }, [transactions, searchQuery]);

    const renderSectionHeader = ({ section: { title } }: { section: { title: string } }) => (
        <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{title}</Text>
        </View>
    );

    const renderItem = ({ item }: { item: any }) => (
        <TransactionItem
            {...item}
            onPress={() => setSelectedTransaction(item.transaction || item)}
        />
    );

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <StatusBar style={isDark ? "light" : "dark"} />

            <ScreenHeader
                variant="simple"
                title="Movimientos"
                showBackButton={true}
                showAvatar={true}
            />

            <SectionList
                sections={sections}
                keyExtractor={(item) => item.id.toString()}
                renderItem={renderItem}
                renderSectionHeader={renderSectionHeader}
                stickySectionHeadersEnabled={false}
                contentContainerStyle={[
                    styles.listContent,
                    { paddingBottom: insets.bottom + 90 }
                ]}
                showsVerticalScrollIndicator={false}
                refreshing={isLoading}
                onRefresh={loadMovements}
                ListHeaderComponent={
                    <>
                        <View style={styles.balanceSection}>
                            <View>
                                <Text style={styles.balanceLabel}>Saldo disponible</Text>
                                <Text style={styles.balanceAmount}>
                                    {showBalance ? formatBalance(account?.balance || 0) : "••••••"}
                                </Text>
                            </View>
                            <TouchableOpacity
                                onPress={() => setShowBalance(!showBalance)}
                                style={styles.eyeButton}
                            >
                                <Ionicons
                                    name={showBalance ? "eye-off-outline" : "eye-outline"}
                                    size={24}
                                    color={colors.mutedForeground}
                                />
                            </TouchableOpacity>
                        </View>

                        <TouchableOpacity
                            style={styles.statementButton}
                            onPress={handleDownloadStatement}
                            disabled={isDownloading}
                            activeOpacity={0.7}
                        >
                            {isDownloading ? (
                                <ActivityIndicator size="small" color={colors.accent} />
                            ) : (
                                <Ionicons name="download-outline" size={20} color={colors.accent} />
                            )}
                            <Text style={styles.statementButtonText}>
                                {isDownloading ? 'Generando PDF...' : 'Descargar estado de cuenta'}
                            </Text>
                        </TouchableOpacity>

                        <View style={styles.filtersSection}>
                            <SearchBar
                                value={searchQuery}
                                onChangeText={setSearchQuery}
                            />
                            <FilterChips
                                activeFilter={activeFilter}
                                onFilterChange={handleFilterChange}
                            />
                        </View>
                    </>
                }
                ListEmptyComponent={
                    !isLoading ? (
                        <View style={styles.emptyState}>
                            <Ionicons name="receipt-outline" size={48} color={colors.mutedAlpha[40]} />
                            <Text style={styles.emptyTitle}>Sin movimientos</Text>
                            <Text style={styles.emptyText}>
                                {searchQuery || activeFilter !== 'todos'
                                    ? "No encontramos resultados con esos filtros"
                                    : "Aún no tienes movimientos registrados"}
                            </Text>
                        </View>
                    ) : null
                }
                ListFooterComponent={<View style={{ height: 80 }} />}
            />

            <DateRangeFilter
                visible={showDateFilter}
                onClose={() => setShowDateFilter(false)}
                onApply={applyDateFilter}
            />

            <TransactionDetailModal
                visible={!!selectedTransaction}
                onClose={() => setSelectedTransaction(null)}
                transaction={selectedTransaction}
            />
        </View>
    );
}

const createStyles = (colors: any) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    listContent: {
        paddingHorizontal: spacing.lg,
    },
    balanceSection: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: spacing.md,
        backgroundColor: colors.card,
        borderRadius: borderRadius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        marginBottom: spacing.md,
    },
    balanceLabel: {
        fontSize: typography.sizes.sm,
        color: colors.mutedForeground,
        marginBottom: 4,
    },
    balanceAmount: {
        fontSize: typography.sizes.xl,
        fontWeight: '700',
        color: colors.foreground,
    },
    eyeButton: {
        padding: 8,
        borderRadius: borderRadius.full,
        backgroundColor: colors.mutedAlpha[20],
    },
    statementButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.base,
        borderRadius: borderRadius.lg,
        borderWidth: 1.5,
        borderColor: colors.border,
        backgroundColor: colors.card,
        marginBottom: spacing.md,
    },
    statementButtonText: {
        fontSize: typography.sizes.base,
        fontWeight: '600',
        color: colors.accent,
    },
    filtersSection: {
        gap: spacing.md,
        marginBottom: spacing.md,
    },
    sectionHeader: {
        paddingVertical: spacing.sm,
        backgroundColor: colors.background,
        marginBottom: spacing.xs,
    },
    sectionHeaderText: {
        fontSize: typography.sizes.sm,
        fontWeight: '600',
        color: colors.mutedForeground,
        textTransform: 'uppercase',
    },
    emptyState: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: spacing['3xl'],
        gap: spacing.sm,
    },
    emptyTitle: {
        fontSize: typography.sizes.lg,
        fontWeight: '600',
        color: colors.foreground,
    },
    emptyText: {
        color: colors.mutedForeground,
        textAlign: 'center',
    },
});
