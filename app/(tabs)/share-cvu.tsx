import React, { useMemo, useRef, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Platform,
    ActivityIndicator,
    Share,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';
import * as Sharing from 'expo-sharing';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { ScreenHeader } from '../../components/layout';
import { Button, AlertDialog } from '../../components/ui';
import { spacing, borderRadius, typography } from '../../theme';
import { getDisplayName } from '../../utils/user';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import QRCode from 'react-native-qrcode-svg';
import { supabase } from '../../lib/supabase';

export default function ShareCvuScreen() {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const { user, account } = useAuth();

    const [alertConfig, setAlertConfig] = useState<{
        visible: boolean;
        title: string;
        description: string;
        variant?: 'default' | 'destructive';
    }>({
        visible: false,
        title: '',
        description: '',
    });

    const showAlert = (title: string, description: string, variant: 'default' | 'destructive' = 'default') => {
        setAlertConfig({ visible: true, title, description, variant });
    };
    const styles = useMemo(() => createStyles(colors), [colors]);
    const [qrValue, setQrValue] = React.useState<string | null>(null);
    const qrViewRef = useRef(null);


    React.useEffect(() => {
        const fetchQr = async () => {
            if (!account?.id) return;

            try {
                const { data, error } = await supabase
                    .from('qr_codes')
                    .select('qr_data')
                    .eq('account_id', account.id)
                    .single<{ qr_data: string }>(); // Cast the data to the defined interface

                if (data && data.qr_data) {
                    setQrValue(data.qr_data);
                }
            } catch (e) {

            }
        };

        fetchQr();
    }, [account?.id]);

    const accountData = {
        titular: user ? (user.account_type === "business" && user.business_profile ? user.business_profile.legal_name : getDisplayName(user)) : "Usuario Magnate",
        cvu: account?.cvu || "0000000000000000000000",
        alias: account?.alias || "sin.alias.asignado",
    };

    const handleCopyData = async () => {
        const textToCopy = `Titular: ${accountData.titular}\nCVU: ${accountData.cvu}\nAlias: ${accountData.alias}`;
        await Clipboard.setStringAsync(textToCopy);
        showAlert("Copiado", "Los datos de tu cuenta han sido copiados al portapapeles.");
    };

    const handleShare = async () => {
        try {
            const textToShare = `Mis datos de cuenta Magnate:\n\nTitular: ${accountData.titular}\nCVU: ${accountData.cvu}\nAlias: ${accountData.alias}`;
            await Share.share({
                message: textToShare,
            });
        } catch (error) {

        }
    };

    const handleSaveQr = async () => {
        try {
            const localUri = await captureRef(qrViewRef, {
                format: 'png',
                quality: 1,
            });

            await Sharing.shareAsync(localUri, {
                mimeType: "image/png",
                dialogTitle: "Compartir o Guardar QR",
            });
        } catch (e) {
            showAlert("Error", "No se pudo preparar la imagen.", "destructive");
        }
    };

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <ScreenHeader
                title="Mis Datos de Cuenta"
                showBackButton={true}
                onBack={() => {
                    if (router.canGoBack()) {
                        router.back();
                    } else {
                        router.push('/menu');
                    }
                }}
            />

            <ScrollView
                contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + 40 }]}
                showsVerticalScrollIndicator={false}
            >
                {/* QR Section */}
                <View style={[styles.qrCard]} ref={qrViewRef} collapsable={false}>
                    <View style={styles.qrContainer}>
                        <View style={styles.qrPattern}>
                            {qrValue ? (
                                <QRCode
                                    value={qrValue}
                                    size={180}
                                    color={colors.foreground}
                                    backgroundColor={colors.card}
                                />
                            ) : (
                                <ActivityIndicator size="large" color={colors.primary} />
                            )}
                        </View>
                    </View>
                    <TouchableOpacity style={styles.downloadButton} onPress={handleSaveQr}>
                        <Ionicons name="download-outline" size={20} color={colors.mutedForeground} />
                        <Text style={styles.downloadText}>Descargar QR</Text>
                    </TouchableOpacity>
                </View>

                {/* Account Details */}
                <View style={styles.detailsCard}>
                    <View style={styles.detailsHeader}>
                        <View style={styles.detailItem}>
                            <Text style={styles.detailLabel}>TITULAR</Text>
                            <Text style={styles.detailValue}>{accountData.titular}</Text>
                        </View>

                        <View style={styles.detailItem}>
                            <Text style={styles.detailLabel}>CVU</Text>
                            <Text style={[styles.detailValue, styles.fontMono]}>{accountData.cvu}</Text>
                        </View>

                        <View style={styles.detailItem}>
                            <Text style={styles.detailLabel}>ALIAS</Text>
                            <Text style={[styles.detailValue, styles.aliasValue]}>{accountData.alias}</Text>
                        </View>
                    </View>

                    <Button
                        onPress={handleCopyData}
                        style={styles.copyButton}
                    >
                        <Ionicons name="copy-outline" size={20} color="white" />
                        <Text style={styles.buttonText}>Copiar Datos</Text>
                    </Button>
                </View>

                {/* Share Button */}
                <TouchableOpacity style={styles.shareOuterButton} onPress={handleShare}>
                    <Ionicons name="share-social-outline" size={20} color={colors.foreground} />
                    <Text style={styles.shareText}>Compartir</Text>
                </TouchableOpacity>

                <View style={{ height: spacing.xl }} />
            </ScrollView>

            <AlertDialog
                visible={alertConfig.visible}
                title={alertConfig.title}
                description={alertConfig.description}
                variant={alertConfig.variant}
                onConfirm={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
                onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
            />
        </View>
    );
}

const createStyles = (colors: any) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    scrollContent: {
        padding: spacing.lg,
        gap: spacing.lg,
    },
    qrCard: {
        backgroundColor: colors.card,
        borderRadius: borderRadius['3xl'],
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.xl,
        alignItems: 'center',
        gap: spacing.lg,
    },
    qrContainer: {
        width: 220,
        height: 220,
        backgroundColor: colors.card,
        borderRadius: borderRadius.xl,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 2,
    },
    qrPattern: {
        width: 180,
        height: 180,
        justifyContent: 'center',
        alignItems: 'center',
    },
    downloadButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.md,
    },
    downloadText: {
        fontSize: 14,
        color: colors.mutedForeground,
        fontWeight: '500',
    },
    detailsCard: {
        backgroundColor: colors.card,
        borderRadius: borderRadius['3xl'],
        borderWidth: 1,
        borderColor: colors.border,
        padding: spacing.xl,
        gap: spacing.xl,
    },
    detailsHeader: {
        gap: spacing.lg,
    },
    detailItem: {
        gap: 4,
    },
    detailLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: colors.mutedForeground,
        letterSpacing: 1,
    },
    detailValue: {
        fontSize: typography.sizes.lg,
        fontWeight: '700',
        color: colors.foreground,
    },
    fontMono: {
        fontSize: 14,
        fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
        opacity: 0.8,
    },
    aliasValue: {
        color: colors.accent,
    },
    copyButton: {
        height: 56,
        borderRadius: borderRadius.xl,
        backgroundColor: colors.accent,
        flexDirection: 'row',
        gap: spacing.sm,
    },
    buttonText: {
        color: 'white',
        fontWeight: '700',
        fontSize: 16,
    },
    shareOuterButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: spacing.sm,
        height: 56,
        borderRadius: borderRadius.xl,
        borderWidth: 1,
        borderColor: colors.border,
    },
    shareText: {
        color: colors.foreground,
        fontWeight: '700',
        fontSize: 16,
    },
});
