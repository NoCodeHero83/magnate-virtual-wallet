import type { User } from '../types/database.types';

type DisplayNameSource = Pick<User, 'first_name' | 'last_name'> &
  Partial<Pick<User, 'account_type' | 'business_profile'>>;

/**
 * Nombre a mostrar del titular: nombre de fantasía / razón social para
 * Persona Jurídica, nombre y apellido para Persona Física.
 */
export function getDisplayName(user: DisplayNameSource | null | undefined, fallback = 'Usuario'): string {
  if (!user) return fallback;
  if (user.account_type === 'business' && user.business_profile) {
    return user.business_profile.trade_name || user.business_profile.legal_name;
  }
  return `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim() || fallback;
}

/** Nombre corto para saludos ("Hola, ...") */
export function getGreetingName(user: DisplayNameSource | null | undefined, fallback = 'Usuario'): string {
  if (!user) return fallback;
  if (user.account_type === 'business' && user.business_profile) {
    return getDisplayName(user, fallback);
  }
  return user.first_name || fallback;
}

export function isBusinessAccount(user: Pick<User, 'account_type'> | null | undefined): boolean {
  return user?.account_type === 'business';
}

/** La cuenta puede enviar / recibir dinero solo cuando está verificada */
export function canOperate(user: Pick<User, 'verification_status'> | null | undefined): boolean {
  return user?.verification_status === 'verified';
}
