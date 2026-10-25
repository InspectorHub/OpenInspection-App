import type { Network } from '../platform/network';

/**
 * The editor asks `isOnline()` synchronously; the platform answers asynchronously. This reads the state once when it
 * is opened and keeps a boolean up to date from the platform's change events. Link state only: `true` does not
 * mean the server is reachable.
 */
export interface NetworkFlag {
  isOnline(): boolean;
  /** Calls `cb` when the state really changes. Returns an unsubscribe function. */
  onOnlineChange(cb: (online: boolean) => void): () => void;
  /** Removes the platform listener and every subscriber. Idempotent. */
  dispose(): void;
}

export async function openNetworkFlag(network: Network): Promise<NetworkFlag> {
  let online = false;
  let changed = false;
  let disposed = false;
  const subscribers = new Set<(online: boolean) => void>();

  // Subscribe before the first read, so a change that arrives while the read is pending is not lost.
  const stopPlatform = network.onChange((next) => {
    if (disposed) return;
    changed = true;
    if (next === online) return;
    online = next;
    for (const cb of [...subscribers]) {
      try {
        cb(next);
      } catch {
        // One subscriber's failure must not stop the others from hearing about the change.
      }
    }
  });

  let initial = false;
  try {
    initial = await network.online();
  } catch {
    // An unreadable state counts as offline: the safe side for a flag that gates writes and uploads.
  }
  if (!changed) online = initial;

  return {
    isOnline: () => online,
    onOnlineChange: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscribers.clear();
      stopPlatform();
    },
  };
}
