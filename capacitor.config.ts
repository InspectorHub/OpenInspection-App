import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.inspectorhub.app',
  appName: 'InspectorHub',
  webDir: 'dist',
  // No server.url: assets are bundled so the app starts without a network.
  plugins: {
    SystemBars: { insetsHandling: 'css' },
    Keyboard: { resize: 'native', resizeOnFullScreen: true },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: true,
      iosKeychainPrefix: 'inspectorhub',
      androidIsEncryption: true,
    },
  },
};

export default config;
