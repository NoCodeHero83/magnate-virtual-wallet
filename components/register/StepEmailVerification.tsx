import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { colors, spacing, borderRadius, typography } from '../../theme';
import { requestSignupEmailCode, verifySignupEmailCode } from '../../services/email.service';

interface StepEmailVerificationProps {
  email: string;
  onVerified: () => void;
}

export const StepEmailVerification: React.FC<StepEmailVerificationProps> = ({ email, onVerified }) => {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    requestCode();
  }, []);

  // El código se genera, guarda (hash) y valida en el servidor
  const requestCode = async () => {
    try {
      setLoading(true);
      setInfo(null);
      const firstName = email.split('@')[0] || 'Usuario';
      const res = await requestSignupEmailCode(email.trim(), firstName);
      setInfo(res.success ? 'Te enviamos un código de 6 dígitos a tu correo.' : res.error || 'No se pudo enviar el código.');
    } catch (e) {
      setInfo('Error al solicitar código.');
    } finally {
      setLoading(false);
    }
  };

  const verifyCode = async () => {
    if (code.trim().length !== 6) {
      setInfo('Ingresá el código de 6 dígitos.');
      return;
    }
    try {
      setLoading(true);
      const res = await verifySignupEmailCode(email.trim(), code.trim());
      if (res.success) {
        onVerified();
      } else {
        setInfo(res.error || 'Código incorrecto o expirado.');
      }
    } catch (e) {
      setInfo('Error al verificar el código.');
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
        <Input
          label="Código de verificación"
          keyboardType="numeric"
          maxLength={6}
          value={code}
          onChangeText={setCode}
          placeholder="000000"
        />
        {info ? <Text style={styles.info}>{info}</Text> : null}

        <Button onPress={verifyCode} loading={loading} style={styles.button}>
          Verificar
        </Button>
        <Button onPress={requestCode} disabled={loading} variant="outline" style={styles.button}>
          Reenviar código
        </Button>
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
  button: {
    height: 56,
    borderRadius: borderRadius.xl,
    marginTop: spacing.sm,
  },
});
