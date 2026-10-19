// app.config.js
export default {
    expo: {
        name: "Magnate",
        slug: "magnate-mobile",
        version: "1.0.9",
        orientation: "portrait",
        icon: "./assets/icon.png",
        scheme: "magnate",
        userInterfaceStyle: "dark",
        newArchEnabled: true,

        splash: {
            image: "./assets/splash-icon.png",
            resizeMode: "contain",
            backgroundColor: "#0f172a"
        },

        ios: {
            supportsTablet: true,
            bundleIdentifier: "com.magnate.mobile",
            infoPlist: {
                ITSAppUsesNonExemptEncryption: false
            }
        },
        android: {
            adaptiveIcon: {
                foregroundImage: "./assets/adaptive-icon.png",
                backgroundColor: "#0F172A"
            },
            permissions: ["CAMERA", "RECORD_AUDIO"],
            package: "com.magnate.mobile",
             versionCode: 9 
        },

        web: {
            favicon: "./assets/favicon.png"
        },

        plugins: [
            [
                "expo-build-properties",
                {
                    android: {
                        minSdkVersion: 26,
                        newArchEnabled: true
                    },
                    ios: {
                        deploymentTarget: "15.1"
                    }
                }
            ],
            "expo-secure-store",
            [
                "onesignal-expo-plugin",
                {
                    mode: process.env.NODE_ENV === "production" ? "production" : "development"
                }
            ]
        ],

        extra: {
            eas: {
                projectId: "08eda603-2863-4758-8210-5180b3267a4f"
            },
            // Variables de entorno de forma segura
            supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
            supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
            oneSignalAppId: process.env.EXPO_PUBLIC_ONESIGNAL_APP_ID,
            // Validación local del CUIT ('test' la omite). ZapSign se configura en Supabase
            // (app_settings + Vault), no acá.
            EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV || 'test'
        }
    }
};
