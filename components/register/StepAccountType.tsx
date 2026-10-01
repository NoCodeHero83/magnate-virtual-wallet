import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '../ui/Button';
import { colors, spacing, borderRadius } from '../../theme';
import type { UserAccountType } from '../../types/database.types';

interface StepAccountTypeProps {
    value: UserAccountType | null;
    onChange: (value: UserAccountType) => void;
    onContinue: () => void;
}

const OPTIONS: { value: UserAccountType; icon: keyof typeof Ionicons.glyphMap; title: string; description: string }[] = [
    {
        value: 'personal',
        icon: 'person-outline',
        title: 'Persona Física',
        description: 'Cuenta personal a tu nombre, con tu DNI y CUIL.',
    },
    {
        value: 'business',
        icon: 'business-outline',
        title: 'Persona Jurídica',
        description: 'Cuenta para tu empresa. Te pediremos los datos del representante legal y de la sociedad.',
    },
];

export const StepAccountType: React.FC<StepAccountTypeProps> = ({ value, onChange, onContinue }) => {
    const insets = useSafeAreaInsets();

    return (
        <ScrollView
            contentContainerStyle={[styles.container, { paddingBottom: spacing.xl + insets.bottom }]}
            showsVerticalScrollIndicator={false}
        >
            <View style={styles.header}>
                <Text style={styles.title}>¿Qué tipo de cuenta quieres abrir?</Text>
                <Text style={styles.subtitle}>Elige la opción que corresponda al titular de la cuenta.</Text>
            </View>

            <View style={styles.options}>
                {OPTIONS.map((option) => {
                    const selected = value === option.value;
                    return (
                        <TouchableOpacity
                            key={option.value}
                            style={[styles.card, selected && styles.cardSelected]}
                            onPress={() => onChange(option.value)}
                            activeOpacity={0.8}
                            accessibilityRole="radio"
                            accessibilityState={{ selected }}
                        >
                            <View style={[styles.iconCircle, selected && styles.iconCircleSelected]}>
                                <Ionicons
                                    name={option.icon}
                                    size={24}
                                    color={selected ? colors.accent : colors.mutedForeground}
                                />
                            </View>
                            <View style={styles.cardText}>
                                <Text style={styles.cardTitle}>{option.title}</Text>
                                <Text style={styles.cardDescription}>{option.description}</Text>
                            </View>
                            <Ionicons
                                name={selected ? 'radio-button-on' : 'radio-button-off'}
                                size={22}
                                color={selected ? colors.accent : colors.mutedForeground}
                            />
                        </TouchableOpacity>
                    );
                })}
            </View>

            <Button onPress={onContinue} disabled={!value} style={styles.button}>
                Continuar
                <Ionicons name="arrow-forward" size={20} color={colors.accentForeground} style={{ marginLeft: 8 }} />
            </Button>
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        paddingHorizontal: spacing.lg,
    },
    header: {
        marginBottom: spacing.lg,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        color: colors.foreground,
        marginBottom: spacing.xs,
    },
    subtitle: {
        fontSize: 14,
        color: colors.mutedForeground,
        lineHeight: 20,
    },
    options: {
        gap: spacing.md,
        marginBottom: spacing.xl,
    },
    card: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.card,
        padding: spacing.md,
        borderRadius: borderRadius.xl,
        borderWidth: 1,
        borderColor: colors.border,
        gap: spacing.md,
    },
    cardSelected: {
        borderColor: colors.accent,
        backgroundColor: colors.accentAlpha[5],
    },
    iconCircle: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: colors.mutedAlpha[10],
        justifyContent: 'center',
        alignItems: 'center',
    },
    iconCircleSelected: {
        backgroundColor: colors.accentAlpha[10],
    },
    cardText: {
        flex: 1,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.foreground,
        marginBottom: 2,
    },
    cardDescription: {
        fontSize: 13,
        color: colors.mutedForeground,
        lineHeight: 18,
    },
    button: {
        height: 56,
        borderRadius: borderRadius.xl,
    },
});
