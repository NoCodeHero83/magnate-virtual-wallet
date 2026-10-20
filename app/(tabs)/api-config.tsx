import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    Switch,
    KeyboardAvoidingView,
    Platform,
    TouchableOpacity,
    ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { ScreenHeader } from '../../components/layout';
import { FormInput } from '../../components/register/FormInput';
import { Button, AlertDialog, PinPromptDialog } from '../../components/ui';
import { spacing, borderRadius } from '../../theme';
import { useTheme } from '../../context/ThemeContext';
import { supabase } from '../../lib/supabase';
import { withOperationalAccount } from '../../components/account/AccountStatusGate';

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ApiAccessData {
    id: string;
    client_id: string;
    is_enabled: boolean;
    allowed_ips: string[];
    rate_limit_per_minute: number;
    last_used_at: string | null;
    created_at: string;
    has_password: boolean;
}

// ─── Componente ───────────────────────────────────────────────────────────────

function ApiConfigScreen() {
    const { colors } = useTheme();

    // Estado del backend
    const [apiData, setApiData] = useState<ApiAccessData | null>(null);
    const [loadingInitial, setLoadingInitial] = useState(true);

    // Estado del formulario
    const [apiEnabled, setApiEnabled] = useState(false);
    const [usernameSuffix, setUsernameSuffix] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [whitelistedIps, setWhitelistedIps] = useState<string[]>([]);
    const [ipInput, setIpInput] = useState('');
    const [isPasswordFocused, setIsPasswordFocused] = useState(false);

    // Estados de loading por acción
    const [loadingEnable, setLoadingEnable] = useState(false);
    const [loadingPassword, setLoadingPassword] = useState(false);
    const [loadingIps, setLoadingIps] = useState(false);

    // Habilitar, cambiar la contraseña o las IPs exige el PIN (lo valida api-setup)
    const [pinAction, setPinAction] = useState<((pin: string) => Promise<void>) | null>(null);
    const askPin = (action: (pin: string) => Promise<void>) => setPinAction(() => action);

    const [alertConfig, setAlertConfig] = useState<{
        visible: boolean;
        title: string;
        description: string;
        variant?: 'default' | 'destructive';
    }>({ visible: false, title: '', description: '' });

    const showAlert = (title: string, description: string, variant: 'default' | 'destructive' = 'default') => {
        setAlertConfig({ visible: true, title, description, variant });
    };

    const styles = useMemo(() => createStyles(colors), [colors]);

    // ── Validaciones de contraseña ──────────────────────────────────────────

    const passwordRequirements = useMemo(() => ([
        { id: 1, label: "Mínimo 8 caracteres", met: password.length >= 8 },
        { id: 2, label: "Al menos 1 Mayúscula", met: /[A-Z]/.test(password) },
        { id: 3, label: "Al menos 1 Número", met: /[0-9]/.test(password) },
        { id: 4, label: "Al menos 1 Carácter especial (!@#$%)", met: /[!@#$%^&*(),.?":{}|<>]/.test(password) },
    ]), [password]);

    const isPasswordValid = passwordRequirements.every(req => req.met);
    const passwordsMatch = password === confirmPassword && password !== '';
    const showRequirements = isPasswordFocused || password.length > 0;

    // ── Cargar estado inicial ───────────────────────────────────────────────

    const loadApiAccess = useCallback(async () => {
        try {
            const { data: raw, error } = await supabase.rpc('get_api_access');
            if (error) throw error;
            // get_api_access no está en los tipos generados de la base
            const data = raw as ApiAccessData | null;

            if (data) {
                setApiData(data);
                setApiEnabled(data.is_enabled);
                setWhitelistedIps(data.allowed_ips ?? []);
                // Extraer el sufijo del client_id (mag_XXXXXXXX_sufijo → sufijo)
                const parts = data.client_id?.split('_') ?? [];
                if (parts.length >= 3) {
                    setUsernameSuffix(parts.slice(2).join('_'));
                }
            }
        } catch (e) {
            console.error('Error cargando api_access:', e);
        } finally {
            setLoadingInitial(false);
        }
    }, []);

    useEffect(() => {
        loadApiAccess();
    }, [loadApiAccess]);

    // ── Helper: llamar api-setup ────────────────────────────────────────────

    const callApiSetup = async (body: object) => {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error('Sin sesión activa');

        const res = await fetch(
            `${process.env.EXPO_PUBLIC_SUPABASE_URL}/functions/v1/api-setup`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                },
                body: JSON.stringify(body),
            }
        );

        const json = await res.json();
        if (json.status === 'error') throw new Error(json.message);
        return json;
    };

    // ── Toggle API (habilitar / deshabilitar) ───────────────────────────────

    const handleToggleApi = async (value: boolean) => {
        // Si está deshabilitando, hacerlo directamente
        if (!value && apiData?.is_enabled) {
            try {
                setLoadingEnable(true);
                await callApiSetup({ action: 'disable' });
                setApiEnabled(false);
                setApiData(prev => prev ? { ...prev, is_enabled: false } : prev);
                showAlert('API deshabilitada', 'El acceso programático a tu cuenta fue desactivado.');
            } catch (e: any) {
                showAlert('Error', e.message, 'destructive');
            } finally {
                setLoadingEnable(false);
            }
            return;
        }

        // Si está habilitando, solo cambiar el estado del toggle
        // El guardado real ocurre al presionar "Habilitar API"
        setApiEnabled(value);
    };

    // ── Habilitar API (crear/actualizar con sufijo y contraseña) ───────────

    const handleEnable = async () => {
        if (!usernameSuffix.trim()) {
            showAlert('Error', 'Ingresá un sufijo para tu usuario API.', 'destructive');
            return;
        }
        if (!isPasswordValid) {
            showAlert('Error', 'La contraseña no cumple los requisitos de seguridad.', 'destructive');
            return;
        }
        if (!passwordsMatch) {
            showAlert('Error', 'Las contraseñas no coinciden.', 'destructive');
            return;
        }

        askPin(async (pin) => {
        try {
            setLoadingEnable(true);
            const result = await callApiSetup({
                action: 'enable',
                client_id_suffix: usernameSuffix.trim(),
                password,
                pin,
            });

            await loadApiAccess(); // Recargar datos actualizados
            setPassword('');
            setConfirmPassword('');
            showAlert('¡API habilitada!', `Tu Client ID es: ${result.client_id}`);
        } catch (e: any) {
            showAlert('Error', e.message, 'destructive');
            setApiEnabled(false); // Revertir toggle si falla
        } finally {
            setLoadingEnable(false);
        }
        });
    };

    // ── Cambiar contraseña ──────────────────────────────────────────────────

    const handleChangePassword = async () => {
        if (!isPasswordValid || !passwordsMatch) return;

        askPin(async (pin) => {
        try {
            setLoadingPassword(true);
            await callApiSetup({ action: 'update_password', password, pin });
            setPassword('');
            setConfirmPassword('');
            showAlert('Contraseña actualizada', 'Tu contraseña API fue cambiada correctamente.');
        } catch (e: any) {
            showAlert('Error', e.message, 'destructive');
        } finally {
            setLoadingPassword(false);
        }
        });
    };

    // ── Agregar IP ──────────────────────────────────────────────────────────

    const handleAddIp = () => {
        if (!ipInput.trim()) return;
        const ipv4Regex = /^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (!ipv4Regex.test(ipInput.trim())) {
            showAlert('Error', 'Formato de IP inválido.', 'destructive');
            return;
        }
        if (whitelistedIps.includes(ipInput.trim())) {
            showAlert('Error', 'La IP ya está en la lista.', 'destructive');
            return;
        }
        setWhitelistedIps(prev => [...prev, ipInput.trim()]);
        setIpInput('');
    };

    const handleRemoveIp = (ip: string) => {
        setWhitelistedIps(prev => prev.filter(i => i !== ip));
    };

    // ── Guardar IPs ─────────────────────────────────────────────────────────

    const handleSaveIps = async () => {
        askPin(async (pin) => {
        try {
            setLoadingIps(true);
            await callApiSetup({ action: 'update_ips', allowed_ips: whitelistedIps, pin });
            showAlert('IPs guardadas', whitelistedIps.length === 0
                ? 'Se permite el acceso desde cualquier IP.'
                : `${whitelistedIps.length} IP(s) configuradas correctamente.`
            );
        } catch (e: any) {
            showAlert('Error', e.message, 'destructive');
        } finally {
            setLoadingIps(false);
        }
        });
    };

    // ── Render ──────────────────────────────────────────────────────────────

    const isNewConfig = !apiData; // No tiene api_access aún
    const isAlreadyEnabled = apiData?.is_enabled === true;

    if (loadingInitial) {
        return (
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <ScreenHeader title="Configuración API" showBackButton onBack={() => router.canGoBack() ? router.back() : router.push('/menu')} />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.accent} />
                </View>
            </SafeAreaView>
        );
    }

    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            <ScreenHeader
                title="Configuración API"
                showBackButton
                onBack={() => router.canGoBack() ? router.back() : router.push('/menu')}
            />

            <KeyboardAvoidingView
                style={{ flex: 1 }}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
                keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
            >
                <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>

                    {/* Warning Card */}
                    <View style={styles.warningCard}>
                        <View style={styles.warningHeader}>
                            <Ionicons name="shield-checkmark-outline" size={24} color={colors.warning} />
                            <Text style={styles.warningTitle}>Zona de Seguridad</Text>
                        </View>
                        <Text style={styles.warningText}>
                            Habilitar la API permite que aplicaciones externas interactúen con tu cuenta. Nunca compartas tus credenciales.
                        </Text>
                    </View>

                    {/* Toggle */}
                    <View style={styles.settingRow}>
                        <View style={styles.settingInfo}>
                            <Text style={styles.settingLabel}>Habilitar API</Text>
                            <Text style={styles.settingDescription}>Permite el acceso programático a tu cuenta.</Text>
                        </View>
                        {loadingEnable && !apiData?.is_enabled ? (
                            <ActivityIndicator size="small" color={colors.accent} />
                        ) : (
                            <Switch
                                value={apiEnabled}
                                onValueChange={handleToggleApi}
                                trackColor={{ false: colors.border, true: colors.accentAlpha[40] }}
                                thumbColor={apiEnabled ? colors.accent : colors.mutedForeground}
                            />
                        )}
                    </View>

                    {/* Client ID actual (si ya está configurado) */}
                    {isAlreadyEnabled && apiData && (
                        <View style={styles.clientIdCard}>
                            <Text style={styles.clientIdLabel}>Tu Client ID</Text>
                            <View style={styles.clientIdRow}>
                                <Text style={styles.clientIdValue} numberOfLines={1}>{apiData.client_id}</Text>
                                <Ionicons name="checkmark-circle" size={20} color={colors.success} />
                            </View>
                            {apiData.last_used_at && (
                                <Text style={styles.lastUsedText}>
                                    Último uso: {new Date(apiData.last_used_at).toLocaleDateString('es-AR')}
                                </Text>
                            )}
                        </View>
                    )}

                    {apiEnabled && (
                        <View style={styles.form}>

                            {/* ── Credenciales ── */}
                            <View style={styles.sectionHeader}>
                                <Ionicons name="key-outline" size={20} color={colors.accent} />
                                <Text style={styles.sectionTitle}>
                                    {isNewConfig || !isAlreadyEnabled ? 'Configurar acceso' : 'Cambiar contraseña'}
                                </Text>
                            </View>

                            {/* Username solo si es configuración nueva o no está habilitado aún */}
                            {(!isAlreadyEnabled) && (
                                <View style={styles.usernamePreview}>
                                    <Text style={styles.usernameLabel}>Usuario API (Client ID)</Text>
                                    <View style={styles.usernameBadge}>
                                        <View style={styles.usernamePrefixContainer}>
                                            <Text style={styles.usernameText} numberOfLines={1}>
                                                mag_••••••••_
                                            </Text>
                                        </View>
                                        <FormInput
                                            placeholder="mi_sufijo"
                                            value={usernameSuffix}
                                            onChangeText={setUsernameSuffix}
                                            containerStyle={styles.inlineInputContainer}
                                            inputContainerStyle={styles.inlineInputWrapper}
                                            showLabel={false}
                                            autoCapitalize="none"
                                            autoCorrect={false}
                                        />
                                    </View>
                                    <Text style={styles.usernameHint}>
                                        Solo letras, números y guiones bajos. Ej: trading, bot_v2
                                    </Text>
                                </View>
                            )}

                            <FormInput
                                label={isAlreadyEnabled ? "Nueva contraseña API" : "Contraseña API"}
                                placeholder="••••••••"
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                icon="lock-closed-outline"
                                onFocus={() => setIsPasswordFocused(true)}
                                onBlur={() => setIsPasswordFocused(false)}
                            />

                            {showRequirements && (
                                <View style={styles.validatorContainer}>
                                    <Text style={styles.validatorTitle}>Requisitos de seguridad:</Text>
                                    {passwordRequirements.map(req => (
                                        <View key={req.id} style={styles.requirementRow}>
                                            <Ionicons
                                                name={req.met ? "checkmark-circle" : "ellipse-outline"}
                                                size={16}
                                                color={req.met ? colors.success : colors.mutedForeground}
                                            />
                                            <Text style={[styles.requirementText, req.met && styles.requirementMet]}>
                                                {req.label}
                                            </Text>
                                        </View>
                                    ))}
                                </View>
                            )}

                            <FormInput
                                label="Confirmar contraseña"
                                placeholder="••••••••"
                                value={confirmPassword}
                                onChangeText={setConfirmPassword}
                                secureTextEntry
                                icon="lock-closed-outline"
                                error={confirmPassword && !passwordsMatch ? "Las contraseñas no coinciden" : undefined}
                            />

                            {/* Botón: habilitar (primera vez) o cambiar contraseña */}
                            {password.length > 0 && (
                                <Button
                                    onPress={isAlreadyEnabled ? handleChangePassword : handleEnable}
                                    style={styles.actionButton}
                                    disabled={!isPasswordValid || !passwordsMatch}
                                    loading={isAlreadyEnabled ? loadingPassword : loadingEnable}
                                >
                                    {isAlreadyEnabled ? 'Cambiar contraseña' : 'Habilitar API'}
                                </Button>
                            )}

                            {/* ── Whitelist de IPs (solo si ya está habilitado) ── */}
                            {isAlreadyEnabled && (
                                <View style={styles.ipSection}>
                                    <View style={styles.sectionHeader}>
                                        <Ionicons name="globe-outline" size={20} color={colors.accent} />
                                        <Text style={styles.sectionTitle}>IPs permitidas</Text>
                                    </View>

                                    <View style={styles.ipInputRow}>
                                        <FormInput
                                            placeholder="192.168.1.1"
                                            value={ipInput}
                                            onChangeText={setIpInput}
                                            containerStyle={{ flex: 1 }}
                                            showLabel={false}
                                            keyboardType="numeric"
                                        />
                                        <TouchableOpacity style={styles.addIpButton} onPress={handleAddIp}>
                                            <Ionicons name="add" size={24} color="white" />
                                        </TouchableOpacity>
                                    </View>

                                    <View style={styles.ipTagsContainer}>
                                        {whitelistedIps.map(ip => (
                                            <View key={ip} style={styles.ipTag}>
                                                <Text style={styles.ipTagText}>{ip}</Text>
                                                <TouchableOpacity onPress={() => handleRemoveIp(ip)}>
                                                    <Ionicons name="close-circle" size={16} color={colors.accent} />
                                                </TouchableOpacity>
                                            </View>
                                        ))}
                                    </View>

                                    {whitelistedIps.length === 0 && (
                                        <View style={styles.emptyIpContainer}>
                                            <Ionicons name="globe-outline" size={48} color={colors.mutedForeground} opacity={0.3} />
                                            <Text style={styles.emptyIpTitle}>Sin IPs configuradas</Text>
                                            <Text style={styles.emptyIpText}>Se permitirá el acceso desde cualquier IP</Text>
                                        </View>
                                    )}

                                    <Button
                                        onPress={handleSaveIps}
                                        loading={loadingIps}
                                        style={styles.saveIpsButton}
                                    >
                                        Guardar IPs
                                    </Button>
                                </View>
                            )}
                        </View>
                    )}

                    {apiEnabled && (
                        <View style={styles.infoHelpCard}>
                            <Text style={styles.infoHelpText}>
                                <Text style={{ fontWeight: '700', color: colors.foreground }}>Importante:</Text> Tu clave API es como la llave de tu cuenta. Nunca la compartas en chats, correos o sitios web. Si sospechas que fue comprometida, cámbiala inmediatamente.
                            </Text>
                        </View>
                    )}

                    <View style={{ height: 120 }} />
                </ScrollView>
            </KeyboardAvoidingView>

            <PinPromptDialog
                visible={!!pinAction}
                onClose={() => setPinAction(null)}
                onConfirm={(pin) => {
                    const action = pinAction;
                    setPinAction(null);
                    action?.(pin);
                }}
                description="Ingresa tu PIN para guardar los cambios del acceso API."
            />

            <AlertDialog
                visible={alertConfig.visible}
                title={alertConfig.title}
                description={alertConfig.description}
                variant={alertConfig.variant}
                onConfirm={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
                onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
            />
        </SafeAreaView>
    );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

const createStyles = (colors: any) => StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    scrollContent: { padding: spacing.lg, gap: spacing.xl },
    warningCard: {
        backgroundColor: colors.background, borderRadius: borderRadius.xl,
        borderWidth: 1, borderColor: colors.warningAlpha[40], padding: spacing.md, gap: spacing.xs,
    },
    warningHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    warningTitle: { fontSize: 14, fontWeight: '700', color: colors.warning },
    warningText: { fontSize: 12, color: colors.mutedForeground, lineHeight: 18 },
    settingRow: {
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        backgroundColor: colors.card, padding: spacing.md, borderRadius: borderRadius.xl,
        borderWidth: 1, borderColor: colors.border,
    },
    settingInfo: { flex: 1, marginRight: spacing.md },
    settingLabel: { fontSize: 16, fontWeight: '600', color: colors.foreground },
    settingDescription: { fontSize: 12, color: colors.mutedForeground, marginTop: 2 },
    clientIdCard: {
        backgroundColor: colors.card, borderRadius: borderRadius.xl, padding: spacing.md,
        borderWidth: 1, borderColor: colors.border, gap: spacing.xs,
    },
    clientIdLabel: { fontSize: 12, color: colors.mutedForeground, fontWeight: '500' },
    clientIdRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    clientIdValue: {
        fontSize: 15, fontWeight: '700', color: colors.foreground, flex: 1,
        fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    },
    lastUsedText: { fontSize: 11, color: colors.mutedForeground },
    form: { gap: spacing.lg },
    sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
    sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.foreground },
    usernamePreview: { gap: spacing.xs },
    usernameLabel: { fontSize: 14, fontWeight: '500', color: colors.mutedForeground, marginLeft: 4 },
    usernameHint: { fontSize: 11, color: colors.mutedForeground, marginLeft: 4 },
    usernameBadge: {
        flexDirection: 'row', alignItems: 'center', backgroundColor: colors.muted,
        borderRadius: borderRadius.lg, height: 56, borderWidth: 1, borderColor: colors.border, overflow: 'hidden',
    },
    usernamePrefixContainer: {
        paddingHorizontal: spacing.lg, justifyContent: 'center', borderRightWidth: 1,
        borderRightColor: colors.border, height: '100%', backgroundColor: colors.mutedAlpha[20],
    },
    usernameText: { fontSize: 14, fontWeight: '700', color: colors.foreground, opacity: 0.8 },
    inlineInputContainer: { flex: 1 },
    inlineInputWrapper: { backgroundColor: 'transparent', borderWidth: 0, height: 54, paddingHorizontal: spacing.md },
    validatorContainer: {
        backgroundColor: colors.mutedAlpha[30], padding: spacing.md, borderRadius: borderRadius.xl,
        gap: spacing.xs, borderWidth: 1, borderColor: colors.border,
    },
    validatorTitle: { fontSize: 12, fontWeight: '700', color: colors.foreground, marginBottom: 4 },
    requirementRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    requirementText: { fontSize: 12, color: colors.mutedForeground },
    requirementMet: { color: colors.success, fontWeight: '500' },
    actionButton: { marginTop: spacing.sm, height: 50, backgroundColor: colors.accent },
    saveIpsButton: { marginTop: spacing.sm, height: 50 },
    ipSection: { marginTop: spacing.xl, gap: spacing.md },
    ipInputRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
    addIpButton: {
        width: 56, height: 56, borderRadius: borderRadius.lg,
        backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center',
    },
    ipTagsContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    ipTag: {
        flexDirection: 'row', alignItems: 'center', backgroundColor: colors.accentAlpha[10],
        paddingHorizontal: spacing.md, paddingVertical: spacing.xs, borderRadius: borderRadius.full,
        gap: spacing.xs, borderWidth: 1, borderColor: colors.accentAlpha[20],
    },
    ipTagText: {
        fontSize: 13, fontWeight: '600', color: colors.accent,
        fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    },
    emptyIpContainer: {
        padding: spacing.xl, backgroundColor: colors.mutedAlpha[20], borderRadius: borderRadius.xl,
        borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, alignItems: 'center', gap: spacing.xs,
    },
    emptyIpTitle: { fontSize: 14, fontWeight: '600', color: colors.foreground, marginTop: spacing.sm },
    emptyIpText: { fontSize: 12, color: colors.warning, textAlign: 'center', fontWeight: '500' },
    infoHelpCard: {
        marginTop: spacing.sm, padding: spacing.md, backgroundColor: colors.mutedAlpha[30],
        borderRadius: borderRadius.xl, borderWidth: 1, borderColor: colors.border,
    },
    infoHelpText: { fontSize: 11, color: colors.mutedForeground, lineHeight: 18 },
});

export default withOperationalAccount(ApiConfigScreen);
