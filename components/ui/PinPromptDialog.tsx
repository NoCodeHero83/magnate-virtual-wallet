import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Modal } from './Modal';
import { Button } from './Button';
import { useTheme } from '../../context/ThemeContext';
import { spacing, typography, borderRadius } from '../../theme';
import { PIN_LENGTH } from '../../constants/app';

interface PinPromptDialogProps {
    visible: boolean;
    onClose: () => void;
    /** Recibe el PIN ingresado; el servidor lo valida */
    onConfirm: (pin: string) => void;
    title?: string;
    description?: string;
    loading?: boolean;
}

/** Pide el PIN antes de una acción sensible (acceso web, acceso API) */
export const PinPromptDialog: React.FC<PinPromptDialogProps> = ({
    visible,
    onClose,
    onConfirm,
    title = 'Confirma con tu PIN',
    description = 'Por seguridad, ingresa tu PIN para continuar.',
    loading = false,
}) => {
    const { colors } = useTheme();
    const [pin, setPin] = useState('');

    useEffect(() => {
        if (visible) setPin('');
    }, [visible]);

    const valid = new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);

    return (
        <Modal visible={visible} onClose={() => !loading && onClose()}>
            <View style={styles.container}>
                <View style={[styles.iconContainer, { backgroundColor: colors.accentAlpha[10] }]}>
                    <Ionicons name="lock-closed-outline" size={32} color={colors.accent} />
                </View>
                <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
                <Text style={[styles.description, { color: colors.mutedForeground }]}>{description}</Text>

                <TextInput
                    value={pin}
                    onChangeText={(v) => setPin(v.replace(/\D/g, '').slice(0, PIN_LENGTH))}
                    keyboardType="number-pad"
                    secureTextEntry
                    maxLength={PIN_LENGTH}
                    autoFocus
                    caretHidden
                    placeholder={'•'.repeat(PIN_LENGTH)}
                    placeholderTextColor={colors.mutedForeground}
                    style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
                    accessibilityLabel="PIN"
                />

                <View style={styles.actions}>
                    <Button variant="ghost" onPress={() => !loading && onClose()} disabled={loading} style={styles.button}>
                        Cancelar
                    </Button>
                    <Button variant="primary" loading={loading} disabled={!valid || loading} onPress={() => onConfirm(pin)} style={styles.button}>
                        Confirmar
                    </Button>
                </View>
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
    },
    iconContainer: {
        width: 64,
        height: 64,
        borderRadius: 32,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: spacing.lg,
    },
    title: {
        fontSize: typography.sizes.xl,
        fontWeight: '700',
        textAlign: 'center',
        marginBottom: spacing.sm,
    },
    description: {
        fontSize: 14,
        textAlign: 'center',
        lineHeight: 20,
        marginBottom: spacing.lg,
    },
    input: {
        width: '100%',
        borderWidth: 1,
        borderRadius: borderRadius.lg,
        paddingVertical: spacing.md,
        fontSize: 24,
        letterSpacing: 12,
        // El espaciado también se agrega después del último dígito: se compensa a la izquierda para centrar
        paddingLeft: 12,
        textAlign: 'center',
        marginBottom: spacing.xl,
    },
    actions: {
        flexDirection: 'row',
        gap: spacing.md,
        width: '100%',
    },
    button: {
        flex: 1,
    },
});
