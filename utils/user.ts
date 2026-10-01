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

export type OperationalBlock = 'pending_review' | 'account_inactive';

/**
 * Motivo por el que el usuario no puede enviar / recibir dinero (null si puede).
 * Requiere usuario verificado y cuenta bancaria activa (la BD aplica la misma regla).
 */
export function getOperationalBlock(
  user: Pick<User, 'verification_status'> | null | undefined,
  account?: { status?: string | null } | null,
): OperationalBlock | null {
  if (!user) return null;
  if (user.verification_status !== 'verified') return 'pending_review';
  if (account && account.status !== 'active') return 'account_inactive';
  return null;
}

export function canOperate(
  user: Pick<User, 'verification_status'> | null | undefined,
  account?: { status?: string | null } | null,
): boolean {
  return getOperationalBlock(user, account) === null;
}
