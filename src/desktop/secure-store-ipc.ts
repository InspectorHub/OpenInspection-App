import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import type { SecureStore } from '../platform/secure-store.ts';

export function createDesktopSecureStore(bridge: Pick<DesktopBridge, 'secrets'>): SecureStore {
  return {
    get: (key) => bridge.secrets.get(key),
    set: (key, value) => bridge.secrets.set(key, value),
    remove: (key) => bridge.secrets.remove(key),
  };
}
