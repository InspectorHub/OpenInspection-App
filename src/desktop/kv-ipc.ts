import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';
import type { KeyValue } from '../platform/kv.ts';

export function createDesktopKeyValue(bridge: Pick<DesktopBridge, 'kv'>): KeyValue {
  return {
    get: (key) => bridge.kv.get(key),
    set: (key, value) => bridge.kv.set(key, value),
  };
}
