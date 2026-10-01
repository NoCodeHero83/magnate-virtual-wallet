import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, FlatList, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { spacing, borderRadius, typography } from '../../theme';
import { useTheme } from '../../context/ThemeContext';

export interface SelectOption {
    value: string;
    label: string;
}

interface SelectProps {
    label?: string;
    placeholder?: string;
    value: string | null;
    options: SelectOption[];
    onChange: (value: string) => void;
    loading?: boolean;
    error?: string;
}

/** Selector simple: campo con apariencia de input que abre una lista en un bottom sheet */
export const Select: React.FC<SelectProps> = ({
    label,
    placeholder = 'Seleccionar',
    value,
    options,
    onChange,
    loading = false,
    error,
}) => {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const styles = useMemo(() => createStyles(colors), [colors]);
    const [open, setOpen] = useState(false);

    const selected = options.find((o) => o.value === value);

    return (
        <View style={styles.container}>
            {label && <Text style={styles.label}>{label}</Text>}

            <TouchableOpacity
                style={[styles.field, error ? styles.fieldError : null]}
                onPress={() => setOpen(true)}
                disabled={loading}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={label}
            >
                <Text style={[styles.value, !selected && styles.placeholder]} numberOfLines={1}>
                    {selected ? selected.label : placeholder}
                </Text>
                {loading ? (
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                ) : (
                    <Ionicons name="chevron-down" size={20} color={colors.mutedForeground} />
                )}
            </TouchableOpacity>
            {error && <Text style={styles.errorText}>{error}</Text>}

            <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
                <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setOpen(false)}>
                    <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]} onStartShouldSetResponder={() => true}>
                        <View style={styles.sheetHeader}>
                            <Text style={styles.sheetTitle}>{label || placeholder}</Text>
                            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={12}>
                                <Ionicons name="close" size={24} color={colors.mutedForeground} />
                            </TouchableOpacity>
                        </View>
                        <FlatList
                            data={options}
                            keyExtractor={(item) => item.value}
                            renderItem={({ item }) => {
                                const isSelected = item.value === value;
                                return (
                                    <TouchableOpacity
                                        style={[styles.option, isSelected && styles.optionSelected]}
                                        onPress={() => {
                                            onChange(item.value);
                                            setOpen(false);
                                        }}
                                    >
                                        <Text style={[styles.optionText, isSelected && styles.optionTextSelected]}>
                                            {item.label}
                                        </Text>
                                        {isSelected && <Ionicons name="checkmark" size={20} color={colors.accent} />}
                                    </TouchableOpacity>
                                );
                            }}
                        />
                    </View>
                </TouchableOpacity>
            </Modal>
        </View>
    );
};

const createStyles = (colors: any) => StyleSheet.create({
    container: {
        gap: spacing.xs,
        width: '100%',
    },
    label: {
        fontSize: typography.sizes.sm,
        fontWeight: '500',
        color: colors.foreground,
    },
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: borderRadius.lg,
        paddingHorizontal: spacing.md,
        height: 54,
        gap: spacing.sm,
    },
    fieldError: {
        borderColor: colors.destructive,
    },
    value: {
        flex: 1,
        fontSize: typography.sizes.base,
        color: colors.foreground,
    },
    placeholder: {
        color: colors.mutedForeground,
    },
    errorText: {
        fontSize: 12,
        color: colors.destructive,
        marginTop: 2,
    },
    overlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.card,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        maxHeight: '70%',
        paddingTop: spacing.md,
    },
    sheetHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
    },
    sheetTitle: {
        fontSize: typography.sizes.lg,
        fontWeight: '600',
        color: colors.foreground,
    },
    option: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
    },
    optionSelected: {
        backgroundColor: colors.accentAlpha?.[10] ?? 'transparent',
    },
    optionText: {
        fontSize: typography.sizes.base,
        color: colors.foreground,
        flex: 1,
    },
    optionTextSelected: {
        color: colors.accent,
        fontWeight: '600',
    },
});
