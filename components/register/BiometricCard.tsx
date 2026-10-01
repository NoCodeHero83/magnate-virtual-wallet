import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Linking, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import WebView from 'react-native-webview';
import { colors, spacing, borderRadius } from '../../theme';
import { createZapSignDocument, getSignerUrl, verifyZapSignIdentity, ZapSignBiometric } from '../../services/zapsign.service';
import { Camera } from 'expo-camera';
import { supabase } from '@/lib/supabase';


type ScanStatus = 'idle' | 'creating' | 'waiting_signature' | 'success' | 'error';

interface BiometricCardProps {
    userName: string;
    userEmail: string;
    onSignatureSuccess?: (docToken: string, contractUrl: string | null, biometric?: ZapSignBiometric) => void;
}

export const BiometricCard: React.FC<BiometricCardProps> = ({ userName, userEmail, onSignatureSuccess }) => {
    const [status, setStatus] = useState<ScanStatus>('idle');
    const [docToken, setDocToken] = useState<string | null>(null);
    const [signUrl, setSignUrl] = useState<string | null>(null);
    const [isWebViewOpen, setIsWebViewOpen] = useState(false);
    const [errorMsg, setErrorMsg] = useState('');

    const handleScan = async () => {
        console.log('[BiometricCard] handleScan start');
        if (!userName || !userEmail) {
            setErrorMsg('Completa tu nombre y email primero');
            setStatus('error');
            setTimeout(() => setStatus('idle'), 3000);
            return;
        }

        if (status !== 'idle' && status !== 'error') return;

        try {
            // Solicitar permiso de cámara antes de abrir WebView
            const camPerm = await Camera.requestCameraPermissionsAsync();
            console.log('[BiometricCard] Camera permission status:', camPerm);
            if (!camPerm.granted) {
                setErrorMsg('Permiso de cámara denegado. Habilítalo en Ajustes.');
                setStatus('error');
                setTimeout(() => setStatus('idle'), 3000);
                return;
            }

            setStatus('creating');
            
            // Creamos documento usando el Template ID
            const res = await createZapSignDocument(
                userName, 
                userEmail
            );
            console.log('[BiometricCard] createZapSignDocument response:', res);

            if (!res.success || !res.signUrl || !res.docToken) {
                setStatus('error');
                setErrorMsg(res.error || 'Error al crear contrato');
                setTimeout(() => setStatus('idle'), 3000);
                return;
            }

            setDocToken(res.docToken);
            let finalSignUrl = res.signUrl || '';
            if (!finalSignUrl) {
                console.log('[BiometricCard] signUrl vacío, intentando obtener desde /docs/{token}');
                const signerRes = await getSignerUrl(res.docToken);
                if (signerRes.success && signerRes.signUrl) {
                    finalSignUrl = signerRes.signUrl;
                } else {
                    console.error('[BiometricCard] No se pudo obtener signUrl:', signerRes.error);
                }
            }
            setSignUrl(finalSignUrl);
            
            // Quedamos en estado de espera en la tarjeta trasera
            setStatus('waiting_signature');
            
            // Re-habilitamos el modal de WebView a pedido del usuario.
            if (finalSignUrl) {
                setIsWebViewOpen(true);
            } else {
                setStatus('error');
                setErrorMsg('No se pudo abrir el flujo de firma. Intente nuevamente.');
                setTimeout(() => setStatus('idle'), 3000);
            }
            
        } catch (error) {
            console.error('[BiometricCard] handleScan error:', error);
            setStatus('error');
            setErrorMsg('Error de red');
            setTimeout(() => setStatus('idle'), 3000);
        }
    };

    const handleVerifySignature = async () => {
    if (!docToken) return;

    setStatus('creating');
    const identity = await verifyZapSignIdentity(docToken);

    if (!identity.signed) {
        setStatus('waiting_signature');
        console.log('[ZapSign] Aún no firmado.');
        setErrorMsg('Aún no has finalizado la firma.');
        setTimeout(() => setErrorMsg(''), 3000);
        return;
    }

    if (!identity.verified) {
        setStatus('waiting_signature');
        console.log('[ZapSign] Verificación biométrica no superada:', identity.biometric);
        setErrorMsg(
            identity.strict
                ? 'La verificación biométrica no se completó correctamente. Intenta de nuevo.'
                : 'No pudimos confirmar la verificación de identidad.',
        );
        setTimeout(() => setErrorMsg(''), 3000);
        return;
    }

    // Contrato firmado y (en su caso) biometría validada: subir PDF a Supabase Storage
    let permanentUrl: string | null = null;

    if (identity.signedFileUrl) {
        try {
            const pdfResponse = await fetch(identity.signedFileUrl);
            if (pdfResponse.ok) {
                const blob = await pdfResponse.blob();
                const arrayBuffer = await new Response(blob).arrayBuffer();
                const fileName = `contracts/presignup/${docToken}.pdf`;

                // El bucket "documents" es privado: el registro solo puede subir archivos
                // nuevos (sin upsert) y se guarda la ruta; el admin lo abre con URL firmada.
                const { error: uploadError } = await supabase.storage
                    .from('documents')
                    .upload(fileName, arrayBuffer, {
                        contentType: 'application/pdf',
                        upsert: false,
                    });

                const alreadyUploaded = /exists|duplicate/i.test(uploadError?.message ?? '');
                if (!uploadError || alreadyUploaded) {
                    permanentUrl = fileName;
                    console.log('[BiometricCard] PDF guardado en storage:', fileName);
                } else {
                    console.error('[BiometricCard] Error subiendo PDF:', uploadError);
                }
            }
        } catch (err) {
            console.error('[BiometricCard] Error descargando/subiendo PDF:', err);
        }
    }

    setStatus('success');
    if (onSignatureSuccess) {
        onSignatureSuccess(docToken, permanentUrl, identity.biometric);
    }
};

    const handleWebViewClose = () => {
        setIsWebViewOpen(false);
        // Cuando el usuario cierra el WebView manualmente, intentamos verificar si terminó
        handleVerifySignature();
    };

    const onNavigationStateChange = (navState: any) => {
        console.log('[BiometricCard] WebView nav change:', navState?.url);
        // ZapSign suele redirigir a URLs específicas o cerrar el flow al terminar.
        // Si detectamos que la URL cambió a una de éxito o el sandbox finalizó, auto-cerramos:
        if (navState.url && (navState.url.includes('/concluido') || navState.url.includes('/success') || navState.url.includes('/finalizado'))) {
             setIsWebViewOpen(false);
             handleVerifySignature();
        }
    };

    const renderButton = () => {
        if (status === 'creating') {
            return (
                <View style={[styles.button, styles.buttonScanning]}>
                    <ActivityIndicator size="small" color={colors.accent} style={{ marginRight: 8 }} />
                    <Text style={styles.buttonTextScanning}>Procesando...</Text>
                </View>
            );
        }
        if (status === 'waiting_signature') {
            return (
                <View style={{ width: '100%', gap: 8 }}>
                    <TouchableOpacity
                        style={[styles.button, styles.buttonScanning]}
                        onPress={handleVerifySignature}
                        activeOpacity={0.7}
                    >
                        <Ionicons name="refresh-outline" size={18} color={colors.accent} style={{ marginRight: 8 }} />
                        <Text style={styles.buttonTextScanning}>Ya firmé (Verificar)</Text>
                    </TouchableOpacity>
                    {errorMsg ? <Text style={{ color: colors.destructive, fontSize: 12, textAlign: 'center' }}>{errorMsg}</Text> : null}
                </View>
            );
        }
        if (status === 'success') {
            return (
                <View style={[styles.button, styles.buttonSuccess]}>
                    <Ionicons name="checkmark-circle" size={18} color="#10B981" style={{ marginRight: 8 }} />
                    <Text style={styles.buttonTextSuccess}>Verificado</Text>
                </View>
            );
        }
        return (
            <View style={{ width: '100%', alignItems: 'center' }}>
                <TouchableOpacity
                    style={[styles.button, status === 'error' ? { borderColor: colors.destructive } : styles.buttonIdle]}
                    onPress={handleScan}
                    activeOpacity={0.7}
                >
                    <Ionicons name="scan-outline" size={18} color={status === 'error' ? colors.destructive : colors.accent} style={{ marginRight: 8 }} />
                    <Text style={status === 'error' ? { color: colors.destructive, fontWeight: '600' } : styles.buttonTextIdle}>
                        Validar identidad
                    </Text>
                </TouchableOpacity>
                {status === 'error' && errorMsg ? (
                    <Text style={{ color: colors.destructive, fontSize: 12, marginTop: 4 }}>{errorMsg}</Text>
                ) : null}
            </View>
        );
    };

    return (
        <View style={[
            styles.container,
            status === 'success' ? styles.containerSuccess : null
        ]}>
            <View style={[
                styles.accentBar,
                status === 'success' ? styles.accentBarSuccess : styles.accentBarIdle
            ]} />

            <View style={[
                styles.iconContainer,
                status === 'success' ? styles.iconContainerSuccess : styles.iconContainerIdle
            ]}>
                <Ionicons
                    name="person-add-outline"
                    size={32}
                    color={status === 'success' ? "#10B981" : colors.accent}
                />
            </View>

            <View style={styles.textContainer}>
                <Text style={styles.title}>
                    {status === 'success' ? 'Identidad Verificada' : 'Identidad Biométrica'}
                </Text>
                <Text style={styles.description}>
                    {status === 'success'
                        ? 'Tu identidad ha sido validada correctamente.'
                        : 'Para cumplir con regulaciones fintech, necesitamos validar que eres tú.'
                    }
                </Text>
            </View>

            {/* Modal para el WebView de ZapSign */}
            <Modal
                visible={isWebViewOpen}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={handleWebViewClose}
            >
                <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'bottom']}>
                    <View style={styles.modalHeader}>
                        <TouchableOpacity onPress={handleWebViewClose} style={styles.closeButton}>
                            <Ionicons name="close" size={24} color={colors.foreground} />
                        </TouchableOpacity>
                        <Text style={styles.modalTitle}>Verificar Identidad (ZapSign)</Text>
                        <View style={{ width: 44 }} />
                    </View>
                    {signUrl ? (
                         <View style={{ flex: 1, backgroundColor: '#fff' }}>
                             <WebView
                                source={{ uri: signUrl as string }}
                                style={{ flex: 1 }}
                                onNavigationStateChange={onNavigationStateChange}
                                javaScriptEnabled={true}
                                domStorageEnabled={true}
                                mixedContentMode="always"
                                allowsInlineMediaPlayback
                                mediaPlaybackRequiresUserAction={false}
                                onPermissionRequest={(event: any) => {
                                    try {
                                        console.log('[BiometricCard] onPermissionRequest resources:', event?.resources);
                                        // Concede permisos solicitados por el contenido (cámara, micrófono)
                                        event.grant(event.resources);
                                    } catch (e) {
                                        console.error('[BiometricCard] onPermissionRequest error:', e);
                                        // Si falla, denegar para evitar estados raros
                                        event.deny?.();
                                    }
                                }}
                                startInLoadingState={true}
                                renderLoading={() => (
                                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background }}>
                                        <ActivityIndicator size="large" color={colors.accent} />
                                    </View>
                                )}
                            />
                         </View>
                    ) : null}
                </SafeAreaView>
            </Modal>

            {renderButton()}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        backgroundColor: 'rgba(0,0,0,0.02)', // Light gray
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: borderRadius.xl,
        padding: spacing.lg,
        alignItems: 'center',
        gap: spacing.sm,
        position: 'relative',
        overflow: 'hidden',
    },
    containerSuccess: {
        borderColor: colors.successAlpha[20],
    },
    accentBar: {
        position: 'absolute',
        top: 0,
        left: 0,
        width: 4,
        height: '100%',
    },
    accentBarIdle: {
        backgroundColor: colors.accent,
    },
    accentBarSuccess: {
        backgroundColor: colors.success,
    },
    iconContainer: {
        padding: spacing.md,
        borderRadius: 50,
        marginBottom: 4,
    },
    iconContainerIdle: {
        backgroundColor: colors.accentAlpha[10],
    },
    iconContainerSuccess: {
        backgroundColor: colors.successAlpha[10],
    },
    textContainer: {
        alignItems: 'center',
        gap: 4,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        color: colors.foreground,
    },
    description: {
        fontSize: 12,
        color: colors.mutedForeground,
        textAlign: 'center',
        maxWidth: 240,
        lineHeight: 18,
    },
    button: {
        width: '100%',
        height: 44,
        borderRadius: borderRadius.lg,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: spacing.sm,
        borderWidth: 1,
    },
    buttonIdle: {
        backgroundColor: colors.card,
        borderColor: colors.accent,
    },
    buttonScanning: {
        backgroundColor: colors.accentAlpha[5],
        borderColor: colors.accent,
    },
    buttonSuccess: {
        backgroundColor: colors.successAlpha[5],
        borderColor: colors.success,
    },
    buttonTextIdle: {
        color: colors.accent,
        fontWeight: '600',
        fontSize: 14,
    },
    buttonTextScanning: {
        color: colors.accent,
        fontWeight: '600',
        fontSize: 14,
    },
    buttonTextSuccess: {
        color: colors.success,
        fontWeight: '600',
        fontSize: 14,
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: colors.card,
    },
    closeButton: {
        padding: 4,
    },
    modalTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.foreground,
    }
});
