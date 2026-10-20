# Instrucciones del proyecto (léelas antes de tocar nada)

## ZapSign y entorno (desarrollo / producción) — se configura en Supabase

La app **no** tiene la API key de ZapSign. Todo pasa por la edge function `zapsign`
(`supabase/functions/zapsign`), que lee de Supabase:

- `app_settings.app_environment`: `"development"` (ZapSign sandbox) o `"production"` (ZapSign real).
- `app_settings.identity_verification_mode`: `"zapsign"` o `"simulated"`. Simulada da la verificación
  por hecha sin ZapSign (en la app aparece "Simular verificación"). **Solo se permite en development**:
  un trigger lo impide en producción y, al pasar a producción, vuelve solo a `"zapsign"`.
- Credenciales en **Supabase Vault** (Project Settings → Vault), según el entorno:
  `zapsign_api_key_sandbox`, `zapsign_template_id_sandbox` /
  `zapsign_api_key_prod`, `zapsign_template_id_prod`, `zapsign_selfie_validation_type_prod` (opcional).

Cada verificación queda en `identity_verifications`. En producción, `handle_new_user` **rechaza el alta**
(`IDENTITY_NOT_VERIFIED`) si no hay una verificación real aprobada para ese email.

Las dos opciones se cambian desde el panel admin: **Configuración → Entorno y verificación de identidad**
(funciones `admin_environment_settings` / `admin_set_environment_settings`, migración `20261020b`).

### Para pasar a PRODUCCIÓN
1. Cargar en Vault `zapsign_api_key_prod` y `zapsign_template_id_prod` (y opcionalmente
   `zapsign_selfie_validation_type_prod` = `liveness-document-match` | `identity-verification-global`).
2. En el panel, elegir "Producción" (no se habilita hasta que estén las credenciales del paso 1).
   Equivale a `update app_settings set value = '"production"' where key = 'app_environment';`

⚠️ **NO usar `import { Constants } from 'expo-constants'`**: en `expo-constants` `Constants` es un
export **solo de tipo** (`export type`); el named import queda `undefined` en runtime. Usar el import por
defecto (`import Constants from 'expo-constants'`), que es lo que hace `utils/env.ts`.

`EXPO_PUBLIC_APP_ENV` (app.config.js, por defecto `test`) ahora solo controla la validación local del CUIT.

## Notas de build (Codemagic)
- `codemagic.yaml` tiene `ios-workflow` y `android-workflow`, ambos usando el grupo `magnate-variables`.
  Ese grupo debe contener al menos `EXPO_TOKEN` (para autenticar `eas build`). ZapSign no necesita
  variables en el build (se configura en Supabase).
- El paso de descarga del artifact usa `eas build --wait 2>&1 | tee` + `grep` de la URL + `curl`
  (no usar `eas build:download --profile/--output`, esos flags no existen en la CLI).
- El `.env` local está gitignoreado y es solo para dev. No se sube a Codemagic.
