import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { FormInput } from './FormInput';
import { Button } from '../ui/Button';
import { Select, SelectOption } from '../ui/Select';
import { AlertDialog } from '../ui/AlertDialog';
import { colors, spacing, borderRadius, typography } from '../../theme';
import { supabase } from '../../lib/supabase';
import { formatCUITCUIL, validateCompanyCUIT, validateCompanyName } from '../../utils/validators';
import { isTestEnv } from '../../config/environment';

export interface CompanyFormData {
    company_cuit: string;
    incorporation_date: Date | null;
    legal_entity_type: string | null;
    legal_name: string;
    trade_name: string;
}

export const emptyCompanyFormData: CompanyFormData = {
    company_cuit: '',
    incorporation_date: null,
    legal_entity_type: null,
    legal_name: '',
    trade_name: '',
};

/** Fecha local → 'YYYY-MM-DD' (sin desfase de zona horaria) */
export const toISODate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const formatDisplayDate = (date: Date) =>
    `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;

export function validateCompanyForm(data: CompanyFormData): string[] {
    const errors: string[] = [];
    const cuitValid = isTestEnv
        ? data.company_cuit.replace(/\D/g, '').length === 11
        : validateCompanyCUIT(data.company_cuit);
    if (!cuitValid) errors.push('CUIT de la empresa inválido (debe empezar con 30, 33 o 34)');
    if (!data.incorporation_date) errors.push('Falta la fecha de inscripción');
    if (!data.legal_entity_type) errors.push('Falta el tipo societario');
    if (!validateCompanyName(data.legal_name)) errors.push('Nombre legal inválido');
    if (data.trade_name.trim() && !validateCompanyName(data.trade_name)) errors.push('Nombre de fantasía inválido');
    return errors;
}

interface StepCompanyDataProps {
    data: CompanyFormData;
    onChange: <K extends keyof CompanyFormData>(field: K, value: CompanyFormData[K]) => void;
    onContinue: () => void;
}

export const StepCompanyData: React.FC<StepCompanyDataProps> = ({ data, onChange, onContinue }) => {
    const insets = useSafeAreaInsets();
    const [entityTypes, setEntityTypes] = useState<SelectOption[]>([]);
    const [loadingTypes, setLoadingTypes] = useState(true);
    const [showDatePicker, setShowDatePicker] = useState(false);
    const [iosDraftDate, setIosDraftDate] = useState<Date>(data.incorporation_date ?? new Date());
    const [alertMessage, setAlertMessage] = useState<string | null>(null);

    useEffect(() => {
        let mounted = true;
        (async () => {
            const { data: rows, error } = await supabase
                .from('legal_entity_types')
                .select('code, name')
                .eq('is_active', true)
                .order('sort_order');
            if (!mounted) return;
            if (error) {
                console.error('[REGISTER] Error loading legal entity types:', error);
                setAlertMessage('No pudimos cargar los tipos societarios. Revisa tu conexión e intenta de nuevo.');
            } else {
                setEntityTypes((rows || []).map((r: any) => ({ value: r.code, label: r.name })));
            }
            setLoadingTypes(false);
        })();
        return () => {
            mounted = false;
        };
    }, []);

    const cuitDigits = data.company_cuit.replace(/\D/g, '').length;

    const handleContinue = () => {
        const errors = validateCompanyForm(data);
        if (errors.length === 0) {
            onContinue();
        } else {
            setAlertMessage(`Revisa los siguientes puntos:\n• ${errors.join('\n• ')}`);
        }
    };

    const handleAndroidDate = (event: any, selected?: Date) => {
        setShowDatePicker(false);
        if (event?.type === 'set' && selected) onChange('incorporation_date', selected);
    };

    return (
        <ScrollView
            contentContainerStyle={[styles.container, { paddingBottom: spacing.xl + insets.bottom }]}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
        >
            <View style={styles.header}>
                <Text style={styles.eyebrow}>KYB · EMPRESA</Text>
                <Text style={styles.title}>Datos de la empresa</Text>
                <Text style={styles.subtitle}>
                    Ingresa los datos tal como figuran en la inscripción de la sociedad.
                </Text>
            </View>

            <View style={styles.form}>
                <View>
                    <FormInput
                        label="CUIT de la empresa"
                        placeholder="30-00000000-0"
                        keyboardType="numeric"
                        maxLength={13}
                        value={data.company_cuit}
                        onChangeText={(text) => onChange('company_cuit', formatCUITCUIL(text))}
                    />
                    <Text style={styles.helper}>{cuitDigits}/11 dígitos</Text>
                </View>

                <View style={styles.fieldGroup}>
                    <Text style={styles.label}>Fecha de inscripción</Text>
                    <TouchableOpacity
                        style={styles.dateField}
                        onPress={() => {
                            setIosDraftDate(data.incorporation_date ?? new Date());
                            setShowDatePicker(true);
                        }}
                        activeOpacity={0.7}
                    >
                        <Text style={[styles.dateText, !data.incorporation_date && styles.placeholder]}>
                            {data.incorporation_date ? formatDisplayDate(data.incorporation_date) : 'DD/MM/AAAA'}
                        </Text>
                        <Ionicons name="calendar-outline" size={20} color={colors.mutedForeground} />
                    </TouchableOpacity>
                </View>

                <Select
                    label="Tipo societario"
                    placeholder="Seleccionar tipo"
                    value={data.legal_entity_type}
                    options={entityTypes}
                    loading={loadingTypes}
                    onChange={(value) => onChange('legal_entity_type', value)}
                />

                <FormInput
                    label="Nombre legal (razón social)"
                    placeholder="Empresa S.A."
                    autoCapitalize="words"
                    value={data.legal_name}
                    onChangeText={(text) => onChange('legal_name', text)}
                />

                <FormInput
                    label="Nombre de fantasía (opcional)"
                    placeholder="Cómo te conocen tus clientes"
                    autoCapitalize="words"
                    value={data.trade_name}
                    onChangeText={(text) => onChange('trade_name', text)}
                />

                <Button onPress={handleContinue} style={styles.button}>
                    Siguiente
                    <Ionicons name="arrow-forward" size={20} color={colors.accentForeground} style={{ marginLeft: 8 }} />
                </Button>
            </View>

            {/* Android: diálogo nativo */}
            {showDatePicker && Platform.OS === 'android' && (
                <DateTimePicker
                    value={data.incorporation_date ?? new Date()}
                    mode="date"
                    display="default"
                    maximumDate={new Date()}
                    onChange={handleAndroidDate}
                />
            )}

            {/* iOS: spinner dentro de un bottom sheet con confirmación */}
            {Platform.OS === 'ios' && (
                <Modal visible={showDatePicker} transparent animationType="slide" onRequestClose={() => setShowDatePicker(false)}>
                    <View style={styles.overlay}>
                        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }]}>
                            <View style={styles.sheetHeader}>
                                <TouchableOpacity onPress={() => setShowDatePicker(false)}>
                                    <Text style={styles.sheetCancel}>Cancelar</Text>
                                </TouchableOpacity>
                                <Text style={styles.sheetTitle}>Fecha de inscripción</Text>
                                <TouchableOpacity
                                    onPress={() => {
                                        onChange('incorporation_date', iosDraftDate);
                                        setShowDatePicker(false);
                                    }}
                                >
                                    <Text style={styles.sheetDone}>Listo</Text>
                                </TouchableOpacity>
                            </View>
                            <DateTimePicker
                                value={iosDraftDate}
                                mode="date"
                                display="spinner"
                                maximumDate={new Date()}
                                themeVariant="dark"
                                onChange={(_e: any, selected?: Date) => selected && setIosDraftDate(selected)}
                            />
                        </View>
                    </View>
                </Modal>
            )}

            <AlertDialog
                visible={!!alertMessage}
                onClose={() => setAlertMessage(null)}
                onConfirm={() => setAlertMessage(null)}
                title="No pudimos continuar"
                description={alertMessage || ''}
                confirmLabel="Entendido"
                showCancel={false}
                icon="alert-circle"
                variant="destructive"
            />
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
    eyebrow: {
        fontSize: 12,
        fontWeight: '600',
        letterSpacing: 2,
        color: colors.accent,
        marginBottom: spacing.xs,
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
    form: {
        gap: spacing.md,
    },
    helper: {
        fontSize: 12,
        color: colors.mutedForeground,
        marginTop: spacing.xs,
    },
    fieldGroup: {
        gap: spacing.xs,
    },
    label: {
        fontSize: typography.sizes.sm,
        fontWeight: '500',
        color: colors.foreground,
    },
    dateField: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.card,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: borderRadius.lg,
        paddingHorizontal: spacing.md,
        height: 54,
    },
    dateText: {
        fontSize: typography.sizes.base,
        color: colors.foreground,
    },
    placeholder: {
        color: colors.mutedForeground,
    },
    button: {
        height: 56,
        borderRadius: borderRadius.xl,
        marginTop: spacing.sm,
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
        paddingTop: spacing.md,
    },
    sheetHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: spacing.lg,
        paddingBottom: spacing.sm,
    },
    sheetTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.foreground,
    },
    sheetCancel: {
        fontSize: 15,
        color: colors.mutedForeground,
    },
    sheetDone: {
        fontSize: 15,
        fontWeight: '600',
        color: colors.accent,
    },
});
