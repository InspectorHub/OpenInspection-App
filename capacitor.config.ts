import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.inspectorhub.app',
  appName: 'InspectorHub',
  webDir: 'dist',
  // 'none' silences Capacitor's own logger in debug builds too. Its debug output carries every plugin call
  // and result (secure-store keys and values, the sign-in callback URL), which is readable over adb on a shared device.
  loggingBehavior: 'none',
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
