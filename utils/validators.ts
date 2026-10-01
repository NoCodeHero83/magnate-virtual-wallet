/**
 * Valida formato de email
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Valida DNI argentino (7-8 digitos)
 */
export function validateDNI(dni: string): boolean {
  const cleanDNI = dni.replace(/\D/g, '');
  return cleanDNI.length >= 7 && cleanDNI.length <= 8;
}

/**
 * Calcula digito verificador de CUIT/CUIL argentino
 * Algoritmo: multiplicar cada digito por peso, sumar, mod 11
 */
function calculateCUITVerifier(cuitWithoutVerifier: string): number {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;

  for (let i = 0; i < 10; i++) {
    sum += parseInt(cuitWithoutVerifier[i]) * weights[i];
  }

  const remainder = sum % 11;

  if (remainder === 0) return 0;
  if (remainder === 1) return 9; // Caso especial
  return 11 - remainder;
}

/**
 * Valida CUIT/CUIL argentino (11 digitos con digito verificador)
 */
export function validateCUITCUIL(cuit: string): boolean {
  const cleanCUIT = cuit.replace(/\D/g, '');

  if (cleanCUIT.length !== 11) {
    return false;
  }

  // Validar tipo (20, 23, 24, 27, 30, 33, 34)
  const tipo = cleanCUIT.substring(0, 2);
  const tiposValidos = ['20', '23', '24', '27', '30', '33', '34'];
  if (!tiposValidos.includes(tipo)) {
    return false;
  }

  // Validar digito verificador
  const cuitWithoutVerifier = cleanCUIT.substring(0, 10);
  const providedVerifier = parseInt(cleanCUIT[10]);
  const calculatedVerifier = calculateCUITVerifier(cuitWithoutVerifier);

  return providedVerifier === calculatedVerifier;
}

/**
 * Valida CUIT de persona jurídica (prefijos 30, 33 o 34 + dígito verificador)
 */
export function validateCompanyCUIT(cuit: string): boolean {
  const cleanCUIT = cuit.replace(/\D/g, '');
  return ['30', '33', '34'].includes(cleanCUIT.substring(0, 2)) && validateCUITCUIL(cleanCUIT);
}

/**
 * Valida razón social / nombre de fantasía: admite letras, números y
 * signos habituales en nombres de empresas (". , & - ' ( ) /")
 */
export function validateCompanyName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 2 && trimmed.length <= 150 && /^[\p{L}\p{N}\s.,&\-'()/]+$/u.test(trimmed);
}

/**
 * Valida PIN de 6 digitos
 */
export function validatePIN(pin: string): boolean {
  const cleanPIN = pin.replace(/\D/g, '');
  return cleanPIN.length === 6;
}

/**
 * Valida telefono argentino
 * Formatos aceptados: +54..., 54..., o solo numeros
 */
export function validatePhone(phone: string): boolean {
  const cleanPhone = phone.replace(/\D/g, '');

  // Minimo 10 digitos (codigo de area + numero)
  if (cleanPhone.length < 10) {
    return false;
  }

  // Si empieza con 54 (codigo de Argentina), debe tener al menos 12 digitos
  if (cleanPhone.startsWith('54') && cleanPhone.length < 12) {
    return false;
  }

  return true;
}

/**
 * Valida nombre (solo letras y espacios, min 2 caracteres)
 */
export function validateName(name: string): boolean {
  const cleanName = name.trim();
  if (cleanName.length < 2) return false;

  const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ\s'-]+$/;
  return nameRegex.test(cleanName);
}

/**
 * Formatea CUIT/CUIL para mostrar (XX-XXXXXXXX-X)
 */
export function formatCUITCUIL(cuit: string): string {
  const cleanCUIT = cuit.replace(/\D/g, '');
  if (cleanCUIT.length !== 11) return cuit;

  return `${cleanCUIT.slice(0, 2)}-${cleanCUIT.slice(2, 10)}-${cleanCUIT.slice(10)}`;
}

/**
 * Formatea DNI para mostrar (XX.XXX.XXX)
 */
export function formatDNI(dni: string): string {
  const cleanDNI = dni.replace(/\D/g, '');
  if (cleanDNI.length < 7) return dni;

  return cleanDNI.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
