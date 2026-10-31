import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import type { AppStatePort } from '../offline/lock-monitor.ts';

export function createDesktopAppState(bridge: Pick<DesktopBridge, 'app'>): AppStatePort {
  return {
    onChange(listener) {
      let active = true;
      const unsubscribe = bridge.app.onActiveChange((isActive) => {
        if (active) listener(isActive);
      });
      return () => {
        if (!active) return;
        active = false;
        unsubscribe();
      };
    },
  };
}
