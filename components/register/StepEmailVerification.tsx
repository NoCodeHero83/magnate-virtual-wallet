import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { colors, spacing, borderRadius } from '../../theme';
import { requestSignupEmailCode, verifySignupEmailCode } from '../../services/email.service';

/** Espera mínima entre códigos (igual que el límite del servidor) */
const RESEND_COOLDOWN_SECONDS = 60;

export interface CodeRequestInfo {
  email: string;
  at: number;
}

interface StepEmailVerificationProps {
  email: string;
  firstName: string;
  /** Último código pedido (vive en la pantalla de registro para sobrevivir al ir y volver) */
  lastRequest: CodeRequestInfo | null;
  onCodeRequested: (info: CodeRequestInfo) => void;
  onVerified: () => void;
  onChangeEmail: () => void;
  onGoToLogin: () => void;
}

const normalize = (email: string) => email.trim().toLowerCase();

export const StepEmailVerification: React.FC<StepEmailVerificationProps> = ({
  email,
  firstName,
  lastRequest,
  onCodeRequested,
  onVerified,
  onChangeEmail,
  onGoToLogin,
}) => {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailInUse, setEmailInUse] = useState(false);
  const [now, setNow] = useState(Date.now());

  const sameEmailRequest = lastRequest && lastRequest.email === normalize(email) ? lastRequest : null;
  const secondsLeft = sameEmailRequest
    ? Math.max(0, RESEND_COOLDOWN_SECONDS - Math.floor((now - sameEmailRequest.at) / 1000))
    : 0;

  // Reloj para la cuenta regresiva del reenvío
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [secondsLeft > 0]);

  useEffect(() => {
    // Si ya se pidió un código para este email hace menos de un minuto, no pedir otro
    if (sameEmailRequest && Date.now() - sameEmailRequest.at < RESEND_COOLDOWN_SECONDS * 1000) {
      setInfo('Ya te enviamos un código de 6 dígitos a tu correo.');
      return;
    }
    requestCode();
  }, []);

  // El código se genera, guarda (hash) y valida en el servidor
  const requestCode = async () => {
    try {
      setLoading(true);
      setInfo(null);
      setError(null);
      const res = await requestSignupEmailCode(email.trim(), firstName.trim() || email.split('@')[0]);
      if (res.success) {
        onCodeRequested({ email: normalize(email), at: Date.now() });
        setNow(Date.now());
        setInfo('Te enviamos un código de 6 dígitos a tu correo.');
      } else {
        if (res.code === 'TOO_SOON') {
          // El servidor ya tiene un código reciente: arrancar la cuenta regresiva igual
          onCodeRequested({ email: normalize(email), at: Date.now() });
          setNow(Date.now());
        }
        setEmailInUse(res.code === 'EMAIL_IN_USE');
        setError(res.error || 'No se pudo enviar el código.');
      }
    } catch (e) {
      setError('Error al solicitar código.');
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async () => {
    if (code.length !== 6) {
      setError('Ingresá el código de 6 dígitos.');
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const res = await verifySignupEmailCode(email.trim(), code);
      if (res.success) {
        onVerified();
      } else {
        setError(res.error || 'Código incorrecto o expirado.');
      }
    } catch (e) {
      setError('Error al verificar el código.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { paddingBottom: spacing.xl + insets.bottom }]}>
      <View style={styles.iconCircle}>
        <Ionicons name="mail" size={44} color={colors.accent} />
      </View>
      <Text style={styles.title}>Verificar correo</Text>
      <Text style={styles.subtitle}>
        Ingresá el código que te enviamos a {email}.
      </Text>

      <View style={{ width: '100%', paddingHorizontal: spacing.lg, marginTop: spacing.md }}>
        {emailInUse ? (
          <>
            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Button onPress={onGoToLogin} style={styles.button}>
              Ir a iniciar sesión
            </Button>
            <Button onPress={onChangeEmail} variant="outline" style={styles.button}>
              Usar otro email
            </Button>
          </>
        ) : (
          <>
            <Input
              label="Código de verificación"
              keyboardType="number-pad"
              maxLength={6}
              value={code}
              onChangeText={(text) => setCode(text.replace(/\D/g, ''))}
              placeholder="000000"
            />
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {!error && info ? <Text style={styles.info}>{info}</Text> : null}

            <Button onPress={verifyCode} loading={loading} disabled={code.length !== 6} style={styles.button}>
              Verificar
            </Button>
            <Button
              onPress={requestCode}
              disabled={loading || secondsLeft > 0}
              variant="outline"
              style={styles.button}
            >
              {secondsLeft > 0 ? `Reenviar código en ${secondsLeft}s` : 'Reenviar código'}
            </Button>
            <Button onPress={onChangeEmail} variant="ghost" style={styles.button}>
              Cambiar email
            </Button>
          </>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: spacing.md,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: colors.accentAlpha[10],
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.xl,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.foreground,
  },
  subtitle: {
    fontSize: 14,
    color: colors.mutedForeground,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
  },
  info: {
    fontSize: 12,
    color: colors.mutedForeground,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  error: {
    fontSize: 13,
    color: colors.destructive,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  button: {
    height: 56,
    borderRadius: borderRadius.xl,
    marginTop: spacing.sm,
  },
});
