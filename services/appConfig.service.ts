// Configuración pública de la plataforma (se edita en Supabase, en app_settings).
import { supabase } from '../lib/supabase';

export interface PublicAppConfig {
    environment: 'development' | 'production';
    /** 'simulated' solo puede estar activo en development */
    identity_verification: 'zapsign' | 'simulated';
}

const DEFAULT_CONFIG: PublicAppConfig = { environment: 'production', identity_verification: 'zapsign' };

/** Ante un error se asume producción con ZapSign (lo más restrictivo) */
export async function getPublicAppConfig(): Promise<PublicAppConfig> {
    const { data, error } = await (supabase as any).rpc('get_public_app_config');
    if (error || !data) return DEFAULT_CONFIG;
    return {
        environment: data.environment === 'development' ? 'development' : 'production',
        identity_verification: data.identity_verification === 'simulated' ? 'simulated' : 'zapsign',
    };
}
