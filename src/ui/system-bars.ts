import { SystemBarsStyle } from '@capacitor/core';

/** The slice of the Capacitor `SystemBars` plugin the app uses. */
export interface SystemBarsPort {
  setStyle(options: { style: SystemBarsStyle }): Promise<void>;
}

/**
 * Returns a function that sets the status and navigation bar content to match the app's colour scheme:
 * light icons (`Dark`) on the dark app, dark icons (`Light`) on the light one. The native side keeps the
 * style it was last given across configuration changes, so after a night-mode switch while the app runs it
 * has to be told again. Failures are dropped: in a browser during development there is no plugin.
 */
export function createSystemBarsSync(port: SystemBarsPort): (dark: boolean) => void {
  return (dark) => {
    try {
      port.setStyle({ style: dark ? SystemBarsStyle.Dark : SystemBarsStyle.Light }).catch(() => undefined);
    } catch {
      // No plugin to ask.
    }
  };
}
