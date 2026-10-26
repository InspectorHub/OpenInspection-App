import { Network as CapacitorNetwork } from '@capacitor/network';

export interface Network {
  /** Link state only: `true` does not mean the server is reachable. */
  online(): Promise<boolean>;
  /** Returns an unsubscribe function that is safe to call immediately. */
  onChange(cb: (online: boolean) => void): () => void;
}

/** The subset of the Network plugin the adapter uses. */
export interface NetworkPluginLike {
  getStatus(): Promise<{ connected: boolean }>;
  addListener(
    eventName: 'networkStatusChange',
    listener: (status: { connected: boolean }) => void,
  ): Promise<{ remove(): Promise<void> }>;
}

export function createNetwork(plugin: NetworkPluginLike): Network {
  return {
    online: async () => (await plugin.getStatus()).connected,
    onChange: (cb) => {
      let active = true;
      const pending = plugin.addListener('networkStatusChange', (status) => {
        if (active) cb(status.connected);
      });
      // A listener that failed to register delivers nothing; it must not surface
      // as an unhandled rejection.
      pending.catch(() => undefined);
      return () => {
        active = false;
        void pending.then((handle) => handle.remove()).catch(() => undefined);
      };
    },
  };
}

/** Thin real-plugin wiring. */
export function createRealNetwork(): Network {
  return createNetwork(CapacitorNetwork);
}
