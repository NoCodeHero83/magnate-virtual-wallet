// contexts/AuthContext.tsx
import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { User, Account, AccountWithType } from '../types/database.types';
import { loginWithPin as loginService, checkDeviceTrust } from '../services/auth.service';
import { saveLastUser } from '../services/storage.service';
import { oneSignalService } from '../services/oneSignalService';
import { getDisplayName } from '../utils/user';

// users + perfil de empresa (1:1, solo para Persona Jurídica)
import { USER_COLUMNS } from '../services/auth.service';
const USER_SELECT = `${USER_COLUMNS}, business_profile:business_profiles(*, legal_entity:legal_entity_types(name))`;

interface AuthContextType {
  user: User | null;
  account: AccountWithType | null;
  session: any;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, pin: string) => Promise<{ success: boolean; error?: string; requireDeviceVerification?: boolean; codeSent?: boolean; debugCode?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  /** Mensaje a mostrar en el login cuando la sesión se cerró por el estado de la cuenta */
  sessionEndedReason: string | null;
  clearSessionEndedReason: () => void;
}

/** Mensaje para cuentas que no pueden usar la app (null si puede ingresar) */
function blockedStatusMessage(status?: string | null, reason?: string | null): string | null {
  if (status === 'rejected') {
    const detail = reason ? `\nMotivo: ${reason}` : '';
    return `Tu solicitud de cuenta fue rechazada.${detail}\nSi crees que es un error, contacta a soporte.`;
  }
  if (status === 'suspended') {
    return 'Tu cuenta fue suspendida. Contacta a soporte para más información.';
  }
  return null;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<AccountWithType | null>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [sessionEndedReason, setSessionEndedReason] = useState<string | null>(null);

  // La sesión solo existe en dispositivos de confianza (el servidor no entrega
  // la credencial a un dispositivo nuevo hasta validar el código por email)
  const isAuthenticated = !!session && !!user;

  // Estado actual para comparar en el listener de realtime (payload.old no trae columnas sin REPLICA IDENTITY FULL)
  const statusRef = useRef<string | undefined>(undefined);
  statusRef.current = user?.verification_status;

  useEffect(() => {
    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        console.log('🔐 Auth event:', event);
        setSession(session);

        // Este callback corre con el lock de auth tomado (setSession lo espera).
        // Consultar Supabase acá adentro lo deja esperando ese mismo lock y la app
        // queda cargando para siempre; por eso el trabajo se difiere.
        setTimeout(async () => {
          if (event === 'SIGNED_IN' && session) {
            await loadUserData(session.user.id);
            // ✅ Vincular con OneSignal después del login
            await oneSignalService.loginUser(session.user.id);
          } else if (event === 'SIGNED_OUT') {
            setUser(null);
            setAccount(null);
            // ✅ Desvincular de OneSignal al hacer logout
            await oneSignalService.logoutUser();
          }
        }, 0);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  // Escuchar cambios de estado de la cuenta (aprobación / rechazo / suspensión por un admin)
  useEffect(() => {
    const userId = user?.id;
    if (!userId) return;

    const channel = supabase
      .channel(`user-status-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${userId}` },
        (payload: any) => {
          const prevStatus = statusRef.current;
          const newStatus = payload.new?.verification_status;
          if (!newStatus || newStatus === prevStatus) return;

          const blocked = blockedStatusMessage(newStatus, payload.new?.status_reason);
          if (blocked) {
            endSession(blocked);
          } else {
            // Recargar usuario y cuenta (la cuenta se activa al aprobar)
            loadUserData(userId);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user?.id]);

  // Saldo en vivo: cuando llega o sale dinero se actualiza la cuenta (y con ella
  // el inicio y los últimos movimientos) sin tener que deslizar para refrescar
  useEffect(() => {
    const accountId = account?.id;
    if (!accountId) return;

    const channel = supabase
      .channel(`account-${accountId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'accounts', filter: `id=eq.${accountId}` },
        (payload: any) => {
          setAccount((prev) => (prev && prev.id === payload.new?.id ? { ...prev, ...payload.new } : prev));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [account?.id]);

  const checkSession = async () => {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);

      if (session?.user) {
        // Sesión guardada: el dispositivo tiene que seguir siendo de confianza
        // (pudo ser desvinculado desde otro dispositivo o por soporte)
        const trusted = await checkDeviceTrust();
        if (!trusted) {
          await endSession('Por seguridad, vuelve a iniciar sesión para verificar este dispositivo.');
          return;
        }

        await loadUserData(session.user.id);
        // ✅ Vincular con OneSignal si ya existe sesión activa
        await oneSignalService.loginUser(session.user.id);
      }
    } catch (error) {
      console.error('Error checking session:', error);
    } finally {
      setLoading(false);
    }
  };

  /** Cierra la sesión dejando un mensaje para mostrar en el login */
  const endSession = async (reason: string) => {
    setSessionEndedReason(reason);
    await logout();
  };

  /** Usuario armado con la metadata de auth cuando el perfil aún no existe en public.users */
  const buildFallbackUser = (authUser: any): User => {
    const metadata = authUser.user_metadata || {};
    return {
      id: authUser.id,
      email: authUser.email || '',
      first_name: metadata.nombres || 'Usuario',
      last_name: metadata.apellidos || '',
      phone: metadata.telefono || '',
      dni: metadata.dni || '',
      cuit_cuil: metadata.cuit || '',
      pin_hash: metadata.pin_hash || '',
      // Sin perfil en la BD no sabemos el estado real: se asume pendiente (no opera)
      verification_status: 'pending',
      account_type: metadata.account_type === 'business' ? 'business' : 'personal',
      status_reason: null,
      business_profile: null,
      web_access_enabled: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      web_password_hash: null,
      web_access_enabled_at: null,
      zapsign_verification_id: null,
      zapsign_verified_at: null,
      zapsign_data: null,
      photo_url: metadata.avatar_url || null,
    };
  };

  /** Perfil del usuario, con reintentos (el trigger de registro puede tardar) */
  const fetchUserProfile = async (userId: string): Promise<User | null> => {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { data, error } = await supabase
        .from('users')
        .select(USER_SELECT)
        .eq('id', userId)
        .single();

      if (!error) return data as User;
      if (error.code !== 'PGRST116') throw error;
      if (attempt < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return null;
  };

  const loadUserData = async (userId: string) => {
    // 1. Perfil
    let userData: User | null = null;
    try {
      userData = await fetchUserProfile(userId);
    } catch (error) {
      console.error('Error loading user profile:', error);
      setUser(null);
      setAccount(null);
      return;
    }

    if (!userData) {
      // El perfil no existe (todavía): usar la metadata de la sesión
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      const authUser = currentSession?.user;
      if (!authUser || authUser.id !== userId) {
        setUser(null);
        setAccount(null);
        return;
      }
      userData = buildFallbackUser(authUser);
    }

    // 2. Cuentas rechazadas o suspendidas no pueden usar la app aunque tengan sesión guardada
    const blocked = blockedStatusMessage(userData.verification_status, userData.status_reason);
    if (blocked) {
      await endSession(blocked);
      return;
    }

    setUser(userData);

    // Save for "Remember Me"
    const isBusiness = userData.account_type === 'business';
    saveLastUser({
      email: userData.email,
      // Para empresas se guarda el nombre a mostrar completo en firstName
      firstName: isBusiness ? getDisplayName(userData) : userData.first_name,
      lastName: isBusiness ? '' : userData.last_name,
      avatarUrl: userData.photo_url ?? undefined
    }).catch(() => { });

    // 3. Cuenta principal (si falla, el usuario se mantiene)
    const { data: accountData, error: accountError } = await supabase
      .from('accounts')
      .select('*, account_types(*)')
      .eq('user_id', userId)
      .eq('is_primary', true)
      .maybeSingle();

    if (accountError) {
      console.error('Error loading account:', accountError);
    }
    setAccount((accountData ?? null) as AccountWithType | null);
  };

  const login = async (email: string, pin: string) => {
    setSessionEndedReason(null);
    try {
      const result = await loginService(email, pin);

      if (result.success) {
        // Dispositivo nuevo: todavía no hay sesión, falta el código por email
        return {
          success: true,
          requireDeviceVerification: !!result.requireDeviceVerification,
          codeSent: result.codeSent,
          debugCode: result.debugCode,
        };
      } else {
        return { success: false, error: result.error };
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  };

  const logout = async () => {
    try {
      setLoading(true);

      // ✅ Desvincular de OneSignal antes de hacer logout
      await oneSignalService.logoutUser();

      await supabase.auth.signOut();
      setUser(null);
      setAccount(null);
      setSession(null);
    } catch (error) {
      console.error('Error logging out:', error);
    } finally {
      setLoading(false);
    }
  };

  const refreshUser = async () => {
    if (!session?.user?.id) return;
    await loadUserData(session.user.id);
  };

  const refreshAccount = async () => {
    if (!session?.user?.id) return;
    await loadUserData(session.user.id);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        account,
        session,
        loading,
        isAuthenticated,
        login,
        logout,
        refreshUser,
        refreshAccount,
        sessionEndedReason,
        clearSessionEndedReason: () => setSessionEndedReason(null),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth debe usarse dentro de AuthProvider');
  }
  return context;
};