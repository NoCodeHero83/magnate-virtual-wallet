// contexts/AuthContext.tsx
import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { User, Account, AccountWithType } from '../types/database.types';
import { loginWithPin as loginService } from '../services/auth.service';
import { saveLastUser } from '../services/storage.service';
import { oneSignalService } from '../services/oneSignalService';
import { getDisplayName } from '../utils/user';

// users + perfil de empresa (1:1, solo para Persona Jurídica)
const USER_SELECT = '*, business_profile:business_profiles(*, legal_entity:legal_entity_types(name))';

interface AuthContextType {
  user: User | null;
  account: AccountWithType | null;
  session: any;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, pin: string) => Promise<{ success: boolean; error?: string; requireDeviceVerification?: boolean }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshAccount: () => Promise<void>;
  pendingDeviceVerification: boolean;
  setPendingDeviceVerification: (val: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [account, setAccount] = useState<AccountWithType | null>(null);
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [pendingDeviceVerification, setPendingDeviceVerification] = useState(false);

  const isAuthenticated = !!session && !!user && !pendingDeviceVerification;

  // Estado actual para comparar en el listener de realtime (payload.old no trae columnas sin REPLICA IDENTITY FULL)
  const statusRef = useRef<string | undefined>(undefined);
  statusRef.current = user?.verification_status;

  useEffect(() => {
    checkSession();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        console.log('🔐 Auth event:', event);
        setSession(session);

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

          if (newStatus === 'suspended' || newStatus === 'rejected') {
            logout();
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

  const checkSession = async () => {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      setSession(session);

      if (session?.user) {
        const email = session.user.email || '';
        const { isDeviceKnown } = await import('../services/auth.service');
        const known = await isDeviceKnown(session.user.id, email);
        
        if (!known) {
          const { sendVerificationOtp } = await import('../services/auth.service');
          await sendVerificationOtp();
          setPendingDeviceVerification(true);
        }

        await loadUserData(session.user.id);
        // ✅ Vincular con OneSignal si ya existe sesión activa y dispositivo conocido
        if (known) await oneSignalService.loginUser(session.user.id);
      }
    } catch (error) {
      console.error('Error checking session:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadUserData = async (userId: string) => {
    try {
      // Retry logic for fetching user profile (handles race condition with Trigger)
      let userData: User | null = null;
      let attempts = 0;
      const maxAttempts = 5; // Increased attempts

      while (attempts < maxAttempts && !userData) {
        attempts++;
        try {
          const { data, error } = await supabase
            .from('users')
            .select(USER_SELECT)
            .eq('id', userId)
            .single();

          if (error) {
            // Only retry on specific errors like "Row not found" (PGRST116)
            if (error.code === 'PGRST116') {
              if (attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 1500)); // Wait longer
                continue;
              }
            }
            throw error;
          }
          userData = data as User;
        } catch (innerError: any) {
          // Handle network errors or other non-supabase errors if needed
          if (innerError.code === 'PGRST116') {
            if (attempts < maxAttempts) {
              await new Promise(resolve => setTimeout(resolve, 1500));
              continue;
            }
          }
          throw innerError;
        }
      }

      setUser(userData);

      // Save for "Remember Me"
      if (userData) {
        const isBusiness = userData.account_type === 'business';
        saveLastUser({
          email: userData.email,
          // Para empresas se guarda el nombre a mostrar completo en firstName
          firstName: isBusiness ? getDisplayName(userData) : userData.first_name,
          lastName: isBusiness ? '' : userData.last_name,
          avatarUrl: userData.photo_url ?? undefined
        }).catch(() => { });
      }

      const { data: accountData, error: accountError } = await supabase
        .from('accounts')
        .select('*, account_types(*)')
        .eq('user_id', userId)
        .eq('is_primary', true)
        .single();

      if (accountError) throw accountError;
      setAccount(accountData as AccountWithType);

    } catch (error: any) {
      // If user not found (PGRST116) force logout AFTER retries failed
      if (error.code === 'PGRST116') {
        // Fallback: Construct user from session metadata if available
        const currentSession = await supabase.auth.getSession();
        const authUser = currentSession.data.session?.user;

        if (authUser && authUser.id === userId) {
          const metadata = authUser.user_metadata || {};
          const fallbackUser: User = {
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
            // Initialize optional fields to null to satisfy User type
            web_password_hash: null,
            web_access_enabled_at: null,
            zapsign_verification_id: null,
            zapsign_verified_at: null,
            zapsign_data: null,
            photo_url: metadata.avatar_url || null
          };
          setUser(fallbackUser);

          // Attempt to fetch account even if user profile failed
          try {
            const { data: accountData, error: accountError } = await supabase
              .from('accounts')
              .select('*, account_types(*)')
              .eq('user_id', userId)
              .eq('is_primary', true)
              .single();

            if (!accountError && accountData) {
              setAccount(accountData as AccountWithType);
            } else {
              setAccount(null); // Ensure account is null if not found
            }
          } catch (accErr) {
            setAccount(null); // Ensure account is null on error
          }

        } else {
          setUser(null);
          setAccount(null); // Also clear account if user fallback fails
        }
      } else {
        console.error('Error loading user data:', error);
        setUser(null);
        setAccount(null);
      }
    }
  };

  const login = async (email: string, pin: string) => {
    try {
      const result = await loginService(email, pin);

      if (result.success) {
        if (result.requireDeviceVerification) {
          setPendingDeviceVerification(true);
          return { success: true, requireDeviceVerification: true };
        } else {
          setPendingDeviceVerification(false);
          return { success: true, requireDeviceVerification: false };
        }
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
        pendingDeviceVerification,
        setPendingDeviceVerification,
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