import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';

declare global {
  interface Window {
    /** Set by the Electron preload script; absent in a browser or a Capacitor webview. */
    oiDesktop?: DesktopBridge;
  }
}

/** The desktop bridge the preload script exposed. Throws outside the desktop client, or on a bridge this build does not speak. */
export function getDesktopBridge(): DesktopBridge {
  const bridge = typeof window === 'undefined' ? undefined : window.oiDesktop;
  if (bridge === undefined) throw new Error('window.oiDesktop is missing: this code runs only inside the desktop client');
  if (bridge.apiVersion !== 1) throw new Error(`Unsupported desktop bridge version: ${String(bridge.apiVersion)}`);
  return bridge;
}
