import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius } from '../../theme';

/**
 * Código enviado por email, visible en pantalla. Solo llega del servidor en el entorno de
 * desarrollo con "Mostrar códigos en pantalla" encendido (Configuración del panel admin).
 */
export function DebugCodeNotice({ code }: { code?: string | null }) {
    if (!code) return null;
    return (
        <View style={styles.box}>
            <Ionicons name="flask-outline" size={18} color={colors.warning} />
            <Text style={styles.text}>
                Entorno de pruebas · tu código es <Text style={styles.code}>{code}</Text>
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    box: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        padding: spacing.md,
        borderRadius: borderRadius.md,
        borderWidth: 1,
        borderColor: colors.warningAlpha[40],
        backgroundColor: colors.warningAlpha[10],
        marginBottom: spacing.md,
    },
    text: {
        flex: 1,
        fontSize: 14,
        color: colors.foreground,
    },
    code: {
        fontWeight: 'bold',
        letterSpacing: 2,
        color: colors.warning,
    },
});
