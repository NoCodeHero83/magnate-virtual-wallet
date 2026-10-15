// Config por defecto de Expo. Único agregado: en la versión web (solo para QA en el
// navegador) expo-secure-store se reemplaza por web-shims/expo-secure-store.ts,
// porque esa librería no tiene implementación web. Android e iOS no cambian.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === 'expo-secure-store') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'web-shims/expo-secure-store.ts') };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
