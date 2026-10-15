// Reemplazo de expo-secure-store SOLO para la versión web (QA en el navegador).
// En el navegador no hay llavero seguro: se usa localStorage. Lo activa metro.config.js
// únicamente cuando platform === 'web'; Android e iOS siguen usando expo-secure-store.

export type SecureStoreOptions = Record<string, unknown>;

export const AFTER_FIRST_UNLOCK = 0;
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 1;
export const ALWAYS = 2;
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = 3;
export const ALWAYS_THIS_DEVICE_ONLY = 4;
export const WHEN_UNLOCKED = 5;
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 6;

const PREFIX = 'securestore:';

export async function isAvailableAsync(): Promise<boolean> {
    return typeof localStorage !== 'undefined';
}

export async function getItemAsync(key: string, _options?: SecureStoreOptions): Promise<string | null> {
    return localStorage.getItem(PREFIX + key);
}

export async function setItemAsync(key: string, value: string, _options?: SecureStoreOptions): Promise<void> {
    localStorage.setItem(PREFIX + key, value);
}

export async function deleteItemAsync(key: string, _options?: SecureStoreOptions): Promise<void> {
    localStorage.removeItem(PREFIX + key);
}

export function getItem(key: string): string | null {
    return localStorage.getItem(PREFIX + key);
}

export function setItem(key: string, value: string): void {
    localStorage.setItem(PREFIX + key, value);
}

export function canUseBiometricAuthentication(): boolean {
    return false;
}
