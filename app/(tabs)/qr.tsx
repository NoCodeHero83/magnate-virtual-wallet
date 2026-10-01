import React, { useState, useMemo, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing } from '../../theme';
import { useTheme } from '../../context/ThemeContext';
import { useIsFocused } from '@react-navigation/native';
import { AlertDialog } from '../../components/ui';
import { QRScannerOverlay } from '../../components/qr/QRScannerOverlay';
import { QRProcessingState } from '../../components/qr/QRProcessingState';
import { useQRHandler } from '../../hooks/useQRHandler';
import { withOperationalAccount } from '../../components/account/AccountStatusGate';

function QrScreen() {
    const { colors } = useTheme();
    const [permission, requestPermission] = useCameraPermissions();
    const [scanned, setScanned] = useState(false);
    const [flash, setFlash] = useState(false);
    const router = useRouter();
    const isFocused = useIsFocused();
    const insets = useSafeAreaInsets();
    const [processing, setProcessing] = useState(false);

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

    const { handleScannedData, pickImage } = useQRHandler({
        setScanned,
        setProcessing,
        showAlert
    });

    const styles = useMemo(() => createStyles(colors, insets), [colors, insets]);

    // Reset scanned state when returning to the screen
    useEffect(() => {
        if (isFocused) {
            setScanned(false);
        }
    }, [isFocused]);

    if (!permission) return <View style={styles.container} />;

    if (!permission.granted) {
        return (
            <View style={[styles.container, styles.centerContent]}>
                <Text style={styles.permissionText}>Necesitamos acceso a la cámara</Text>
                <TouchableOpacity style={styles.permissionButton} onPress={requestPermission}>
                    <Text style={styles.permissionButtonText}>Dar Permiso</Text>
                </TouchableOpacity>
            </View>
        );
    }

    return (
        <View style={styles.container}>
            {isFocused && (
                <CameraView
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    enableTorch={flash}
                    onBarcodeScanned={scanned ? undefined : (event) => {
                        setScanned(true);
                        handleScannedData(event.data);
                    }}
                    barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                />
            )}

            <QRScannerOverlay />

            {/* Custom Bottom Controls over Overlay */}
            {/* The Overlay component handles the visual frame, but we need interactive buttons on top */}
            <View style={styles.bottomContainer}>
                <Text style={styles.instructions}>Escanea un código QR para pagar</Text>
                <TouchableOpacity onPress={pickImage} style={styles.bottomImageButton}>
                    <Ionicons name="image-outline" size={24} color={colors.foreground} />
                    <Text style={styles.bottomImageText}>Cargar imagen</Text>
                </TouchableOpacity>
            </View>

            {/* Header Controls */}
            <View style={styles.controlsContainer}>
                <TouchableOpacity onPress={() => router.back()} style={styles.iconButton}>
                    <Ionicons name="arrow-back" size={24} color={colors.foreground} />
                </TouchableOpacity>

                <TouchableOpacity
                    onPress={() => setFlash(!flash)}
                    style={[styles.iconButton, flash && styles.iconActive]}
                >
                    <Ionicons name={flash ? "flash" : "flash-off"} size={24} color={flash ? colors.warning : colors.foreground} />
                </TouchableOpacity>
            </View>

            <AlertDialog
                visible={alertConfig.visible}
                title={alertConfig.title}
                description={alertConfig.description}
                variant={alertConfig.variant}
                onConfirm={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
                onClose={() => setAlertConfig(prev => ({ ...prev, visible: false }))}
            />

            {processing && <QRProcessingState />}
        </View >
    );
}

const createStyles = (colors: any, insets: any) => StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    controlsContainer: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        paddingTop: insets.top + spacing.md,
        paddingHorizontal: spacing.lg,
        flexDirection: 'row',
        justifyContent: 'space-between',
        zIndex: 20, // Higher than overlay
    },
    bottomContainer: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        paddingBottom: insets.bottom + 100,
        alignItems: 'center',
        zIndex: 20,
    },
    iconButton: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.background + '80',
        justifyContent: 'center',
        alignItems: 'center',
    },
    iconActive: {
        backgroundColor: colors.primary,
    },
    centerContent: {
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    permissionText: {
        color: colors.foreground,
        textAlign: 'center',
        marginBottom: 20,
        fontSize: 16,
    },
    permissionButton: {
        backgroundColor: colors.primary,
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 8,
    },
    permissionButtonText: {
        color: colors.primaryForeground,
        fontWeight: 'bold',
    },
    instructions: {
        color: colors.foreground,
        fontSize: 16,
        fontWeight: '600',
        textAlign: 'center',
        marginBottom: 20,
    },
    bottomImageButton: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.primary + '20',
        paddingVertical: 12,
        paddingHorizontal: 20,
        borderRadius: 24,
        gap: 8,
    },
    bottomImageText: {
        color: colors.foreground,
        fontSize: 14,
        fontWeight: '600',
    },
});

export default withOperationalAccount(QrScreen);
