import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'io.inspectorhub.app',
  appName: 'InspectorHub',
  webDir: 'dist',
  // 'none' silences Capacitor's own logger in debug builds too. Its debug output carries every plugin call
  // and result (secure-store keys and values, the sign-in callback URL), which is readable over adb on a shared device.
  // The ONE exception is the CI simulator job, which sets OI_NATIVE_LOGGING=debug while it syncs: a simulator with
  // synthetic data, whose console is the only way to see why the app did not start. Any other value, or none, is 'none';
  // src/capacitor-config.test.ts and src/release-workflows.test.ts keep it that way.
  loggingBehavior: process.env.OI_NATIVE_LOGGING === 'debug' ? 'debug' : 'none',
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
