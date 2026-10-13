import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '../context/ThemeContext';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { LogoIcon } from '../components/LogoIcon';
import { colors } from '../theme';
import { oneSignalService } from '../services/oneSignalService';
import { supabase } from '../lib/supabase';
import { InactivityWrapper } from '../components/InactivityWrapper';
import { UpdateModal } from '../components/UpdateModal';

function RootLayoutNav() {
    const { session, loading, user } = useAuth();
    const segments = useSegments();
    const router = useRouter();

    useEffect(() => {
        if (loading) return;

        const inAuthGroup = segments[0] === '(auth)';
        const inTabsGroup = segments[0] === '(tabs)';

        if (session && user) {
            // PIN de 4 dígitos: hay que crear uno de 6 antes de usar la app
            if (user.pin_upgrade_required) {
                if (!(inTabsGroup && (segments as string[])[1] === 'change-pin')) {
                    router.replace('/(tabs)/change-pin');
                }
                return;
            }
            if (inAuthGroup) {
                // Si hay sesión Y usuario verificado, y estamos en grupo auth (login/register), ir a tabs
                router.replace('/(tabs)');
            }
        } else if (!session && inTabsGroup) {
            // Si NO hay sesión y estamos en tabs, ir a login
            router.replace('/(auth)/login');
        }
    }, [session, loading, segments, user]);

    if (loading) {
        return (
            <View style={styles.loadingContainer}>
                <LogoIcon size={80} />
                <ActivityIndicator size="large" color={colors.primary} style={styles.loader} />
            </View>
        );
    }

    return (
        <Stack
            screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.background },
            }}
        >
            <Stack.Screen name="index" />
            <Stack.Screen name="(auth)/login" />
            <Stack.Screen name="(tabs)" />
            <Stack.Screen name="payment/confirm" options={{ animation: 'none' }} />
            <Stack.Screen name="payment/success" options={{ animation: 'none', gestureEnabled: false }} />
        </Stack>
    );
}

export default function RootLayout() {
    useEffect(() => {
        // 1. Inicializar OneSignal
        oneSignalService.initialize();

        // 2. Escuchar cambios de autenticación
        const { data: { subscription } } = supabase.auth.onAuthStateChange(
            async (event, session) => {
                if (event === 'SIGNED_IN' && session?.user) {
                    await oneSignalService.loginUser(session.user.id);
                } else if (event === 'SIGNED_OUT') {
                    await oneSignalService.logoutUser();
                }
            }
        );

        return () => {
            subscription.unsubscribe();
        };
    }, []);

    return (
        <SafeAreaProvider>
            <ThemeProvider>
                <AuthProvider>
                    <InactivityWrapper>
                        <StatusBar style="light" />
                        <RootLayoutNav />
                        <UpdateModal />
                    </InactivityWrapper>
                </AuthProvider>
            </ThemeProvider>
        </SafeAreaProvider>
    );
}

const styles = StyleSheet.create({
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.background,
    },
    loader: {
        marginTop: 20,
    },
});
