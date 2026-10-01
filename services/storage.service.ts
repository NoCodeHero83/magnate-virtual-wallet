import AsyncStorage from "@react-native-async-storage/async-storage";

export interface SavedUser {
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
}

export interface Settings {
  emailAlerts: boolean;
}

const KEYS = {
  LAST_USER: "magnate_last_user",
  SETTINGS: "magnate_settings",
};

export const saveLastUser = async (user: SavedUser): Promise<void> => {
  try {
    await AsyncStorage.setItem(KEYS.LAST_USER, JSON.stringify(user));
  } catch (error) {
    console.error("Error saving last user:", error);
  }
};

export const getLastUser = async (): Promise<SavedUser | null> => {
  try {
    const json = await AsyncStorage.getItem(KEYS.LAST_USER);
    return json ? JSON.parse(json) : null;
  } catch (error) {
    console.error("Error getting last user:", error);
    return null;
  }
};

export const clearLastUser = async (): Promise<void> => {
  try {
    await AsyncStorage.removeItem(KEYS.LAST_USER);
  } catch (error) {
    console.error("Error clearing last user:", error);
  }
};

export const saveSettings = async (settings: Settings): Promise<void> => {
  try {
    await AsyncStorage.setItem(KEYS.SETTINGS, JSON.stringify(settings));
  } catch (error) {
    console.error("Error saving settings:", error);
  }
};

export const getSettings = async (): Promise<Settings | null> => {
  try {
    const json = await AsyncStorage.getItem(KEYS.SETTINGS);
    return json ? JSON.parse(json) : null;
  } catch (error) {
    console.error("Error getting settings:", error);
    return null;
  }
};
