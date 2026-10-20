import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { supabase } from '../lib/supabase';
import type { AppVersion } from '../types/database.types';
import { compareVersions } from '../utils/version';

interface UpdateInfo {
  isUpdateAvailable: boolean;
  isMandatory: boolean;
  storeUrl: string;
  latestVersion: string;
  loading: boolean;
}

export const useAppUpdate = () => {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({
    isUpdateAvailable: false,
    isMandatory: false,
    storeUrl: '',
    latestVersion: '',
    loading: true,
  });

  useEffect(() => {
    const checkUpdate = async () => {
      try {
        const platform = Platform.OS === 'ios' ? 'ios' : 'android';
        
        // Fetch the latest version for the current platform
        const { data: row, error } = await supabase
          .from('app_versions')
          .select('*')
          .eq('platform', platform)
          .order('id', { ascending: false }) // Get the latest entry
          .limit(1)
          .single();

        if (error) {
            // It might fail if no rows, but single() with no rows returns error code PGRST116
            if (error.code !== 'PGRST116') {
                console.error('Error checking for updates:', error);
            }
            setUpdateInfo(prev => ({ ...prev, loading: false }));
            return;
        }

        const data = row as AppVersion | null;
        if (data) {
          const currentVersion = Constants.expoConfig?.version || '1.0.0';
          const latestVersion = data.version;
          
          // Compare versions: if current < latest, update is needed
          const comparison = compareVersions(currentVersion, latestVersion);
          const isUpdateAvailable = comparison < 0;

          setUpdateInfo({
            isUpdateAvailable,
            isMandatory: data.mandatory,
            storeUrl: data.store_url || '',
            latestVersion,
            loading: false,
          });
        } else {
            setUpdateInfo(prev => ({ ...prev, loading: false }));
        }
      } catch (error) {
        console.error('Error in checkUpdate:', error);
        setUpdateInfo(prev => ({ ...prev, loading: false }));
      }
    };

    checkUpdate();
  }, []);

  return updateInfo;
};
