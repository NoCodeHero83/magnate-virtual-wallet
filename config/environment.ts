/**
 * Environment configuration for Magnate Financial Freedom
 * Controls test vs production behavior.
 *
 * Set EXPO_PUBLIC_APP_ENV=test for testing / Play Store review accounts.
 * Set EXPO_PUBLIC_APP_ENV=production for live production builds.
 *
 * ZapSign ya no se configura en la app: lo maneja la edge function "zapsign" según
 * app_settings.app_environment (sandbox / producción) y las credenciales de Supabase Vault.
 * La verificación simulada se activa con app_settings.identity_verification_mode.
 */

import { getEnvVar } from '../utils/env';

const APP_ENV = (getEnvVar('EXPO_PUBLIC_APP_ENV') || 'test') as 'test' | 'production';

export const isTestEnv = APP_ENV === 'test';
export const isProductionEnv = APP_ENV === 'production';

/**
 * Validate CUIT/CUIL formula
 * In test mode: always returns true (accepts any value)
 * In production mode: performs real mathematical validation
 */
export const shouldValidateCuit = isProductionEnv;
