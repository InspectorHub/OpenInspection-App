import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

/** The emulator's own loopback, which `adb reverse` forwards to the Vite dev server on the host. localhost is a secure context, so crypto.randomUUID and crypto.subtle exist; a 10.0.2.2 address is not, and the app would fail at its first device id. */
const EMULATOR_DEV_SERVER = 'http://localhost:5173';

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
  // No server.url: assets are bundled so the app starts without a network. The ONE exception is the CI emulator job's second build,
  // which sets OI_EMULATOR_DEV_SERVER to exactly the address below while it syncs, so the WebView loads the Vite dev bundle (the only
  // build that accepts plain http) from the host. Any other value, or none, leaves server unset; src/capacitor-config.test.ts and
  // src/release-workflows.test.ts keep it that way.
  server: process.env.OI_EMULATOR_DEV_SERVER === EMULATOR_DEV_SERVER ? { url: EMULATOR_DEV_SERVER, cleartext: true } : undefined,
  plugins: {
    SystemBars: { insetsHandling: 'css' },
    // iOS only (Android sizes the window itself; resizeOnFullScreen is its own switch). 'none': the soft keyboard covers the web view instead of
    // shrinking it, and iOS scrolls a covered field into view by itself. With 'native' the web view was resized about 600 ms AFTER the keyboard
    // started to rise: bars fixed to the bottom were laid out a frame late and flickered, and the strip the web view no longer covered showed
    // the window's black through the keyboard's rounded corners (measured on an iPhone 12, 2026-11-07).
    Keyboard: { resize: KeyboardResize.None, resizeOnFullScreen: true },
    CapacitorSQLite: {
      iosDatabaseLocation: 'Library/CapacitorDatabase',
      iosIsEncryption: true,
      iosKeychainPrefix: 'inspectorhub',
      androidIsEncryption: true,
    },
  },
};

export default config;
