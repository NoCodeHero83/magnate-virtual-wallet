// src/services/oneSignalService.ts
import {
    OneSignal,
    LogLevel,
    NotificationWillDisplayEvent,
    NotificationClickEvent,
    PushSubscriptionChangedState,
    OSNotification
} from 'react-native-onesignal';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { supabase } from '@/lib/supabase';
import { getLocalDeviceId } from './auth.service';

class OneSignalService {
    private isInitialized = false;

    /**
     * Inicializa OneSignal
     * Llamar una sola vez al inicio de la app
     */
    initialize() {
        if (this.isInitialized) {
            console.log('OneSignal ya está inicializado');
            return;
        }

        const appId = Constants.expoConfig?.extra?.oneSignalAppId;

        if (!appId) {
            console.error('⚠️ ONESIGNAL_APP_ID no está configurado en .env');
            return;
        }

        try {
            // Inicializar OneSignal
            OneSignal.initialize(appId);

            // Configurar log level (solo en desarrollo)
            if (__DEV__) {
                OneSignal.Debug.setLogLevel(LogLevel.Verbose);
            }

            // Solicitar permisos de notificaciones
            this.requestPermissions();

            // Configurar listeners
            this.setupListeners();

            this.isInitialized = true;
            console.log('✅ OneSignal inicializado correctamente');
        } catch (error) {
            console.error('❌ Error al inicializar OneSignal:', error);
        }
    }

    /**
     * Solicita permisos de notificaciones al usuario
     */
    private async requestPermissions() {
        try {
            // iOS: muestra el prompt nativo
            // Android: no necesita prompt explícito
            const permission = await OneSignal.Notifications.requestPermission(true);
            console.log('Permiso de notificaciones:', permission);
        } catch (error) {
            console.error('Error al solicitar permisos:', error);
        }
    }

    /**
     * Configura los listeners de eventos
     */
    private setupListeners() {
        // Listener: cuando se recibe una notificación (app en foreground)
        OneSignal.Notifications.addEventListener(
            'foregroundWillDisplay',
            (event: NotificationWillDisplayEvent) => {
                console.log('📩 Notificación recibida en foreground:', event.notification);
                // Mostrar la notificación
                event.preventDefault();
                event.notification.display();
            }
        );

        // Listener: cuando el usuario toca la notificación
        OneSignal.Notifications.addEventListener(
            'click',
            (event: NotificationClickEvent) => {
                console.log('👆 Usuario tocó la notificación:', event.notification);
                this.handleNotificationClick(event.notification);
            }
        );

        // Listener: cambios en la suscripción
        OneSignal.User.pushSubscription.addEventListener(
            'change',
            (subscription: PushSubscriptionChangedState) => {
                console.log('🔄 Cambio en la suscripción:', subscription);
                if (subscription.current.id) {
                    this.saveDeviceToDatabase(subscription.current.id);
                }
            }
        );
    }

    /**
     * Vincula el usuario actual con OneSignal (External ID)
     * Llamar después del login exitoso
     */
    async loginUser(userId: string) {
        try {
            console.log('🔗 Vinculando usuario a OneSignal:', userId);
            await OneSignal.login(userId);

            // Obtener el player_id actual
            const playerId = await OneSignal.User.pushSubscription.getIdAsync();
            if (playerId) {
                await this.saveDeviceToDatabase(playerId);
            }

            console.log('✅ Usuario vinculado correctamente');
        } catch (error) {
            console.error('❌ Error al vincular usuario:', error);
        }
    }

    /**
     * Desvincula el usuario de OneSignal
     * Llamar al hacer logout
     */
    async logoutUser() {
        try {
            console.log('🔓 Desvinculando usuario de OneSignal');
            await OneSignal.logout();
            console.log('✅ Usuario desvinculado correctamente');
        } catch (error) {
            console.error('❌ Error al desvincular usuario:', error);
        }
    }

    /**
     * Guarda/actualiza el dispositivo en Supabase
     */
    private async saveDeviceToDatabase(playerId: string) {
        try {
            const { data: { user } } = await supabase.auth.getUser();

            if (!user) {
                console.log('⚠️ No hay usuario autenticado, no se guarda el dispositivo');
                return;
            }

            // Obtener información del dispositivo
            const optedIn = await OneSignal.User.pushSubscription.getOptedInAsync();
            
            // Use exactly the same local device id used for Authentication
            const deviceId = await getLocalDeviceId();

            // ✅ CORREGIDO: Llamar al RPC en Supabase para reclamar el device sin violar unique constraints ni RLS
            const rpcArgs = {
                p_player_id: playerId,
                p_device_id: deviceId,
                p_user_id: user.id,
                p_platform: Platform.OS as 'ios' | 'android',
                p_push_enabled: optedIn,
                p_device_os_version: String(Platform.Version),
                p_app_version: Constants.expoConfig?.version || '1.0.0'
            };

            console.log('💾 Llamando RPC para guardar dispositivo:', rpcArgs);

            const { error: rpcError } = await supabase.rpc('claim_onesignal_device', rpcArgs as any);

            if (rpcError) {
                console.error('❌ Error al ganar ownership del dispositivo usando RPC:', rpcError);
                
                // Sin fallback: los clientes no pueden escribir user_devices directamente
            } else {
                console.log('✅ Dispositivo guardado exitosamente en BD (vía RPC):', playerId);
            }
        } catch (error) {
            console.error('❌ Error en saveDeviceToDatabase:', error);
        }
    }

    /**
     * Obtiene un ID único del dispositivo (Ya no se usa localmente, pero se mantiene por compatibilidad)
     */
    private async getDeviceId(playerId?: string): Promise<string> {
        try {
            // Utilizamos la misma funcion base del auth para no perder coherencia
            return await getLocalDeviceId();
        } catch (error) {
            console.error('Error obteniendo device_id:', error);
            return 'unknown';
        }
    }

    /**
     * Maneja el click en una notificación
     */
    private handleNotificationClick(notification: OSNotification) {
        const data = notification.additionalData as any;

        console.log('📨 Data de la notificación:', data);

        // Navegar según el tipo de notificación
        if (data?.type === 'transaction' && data?.transaction_id) {
            console.log('Navegar a transacción:', data.transaction_id);

            // TODO: Ajustar esta ruta según tu estructura de navegación
            router.push({
                pathname: '/(tabs)/transactions/[id]',
                params: { id: data.transaction_id }
            });
        }
    }

    /**
     * Activa/desactiva las notificaciones push en este dispositivo
     */
    async togglePushNotifications(enabled: boolean) {
        try {
            if (enabled) {
                await OneSignal.Notifications.requestPermission(true);
            } else {
                OneSignal.User.pushSubscription.optOut();
            }

            // Actualizar en la base de datos
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                const playerId = await OneSignal.User.pushSubscription.getIdAsync();

                const { error } = await (supabase
                    .from('user_devices') as any)
                    .update({ push_enabled: enabled })
                    .eq('user_id', user.id)
                    .eq('player_id', playerId || '');

                if (error) {
                    console.error('Error al actualizar push_enabled:', error);
                } else {
                    console.log(`✅ Notificaciones ${enabled ? 'activadas' : 'desactivadas'}`);
                }
            }
        } catch (error) {
            console.error('❌ Error al cambiar estado de notificaciones:', error);
        }
    }

    /**
     * Obtiene el estado actual de las notificaciones
     */
    async getPushSubscriptionState() {
        return {
            playerId: await OneSignal.User.pushSubscription.getIdAsync(),
            token: await OneSignal.User.pushSubscription.getTokenAsync(),
            optedIn: await OneSignal.User.pushSubscription.getOptedInAsync()
        };
    }
}

// Exportar instancia única (singleton)
export const oneSignalService = new OneSignalService();