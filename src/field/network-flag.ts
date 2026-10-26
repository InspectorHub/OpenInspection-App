import { realTimers, type TimerPort } from '../collab/timers';
import type { Network } from '../platform/network';

/**
 * The editor asks `isOnline()` synchronously; the platform answers asynchronously. This subscribes at once and reads
 * the state once, then keeps a boolean up to date from the platform's change events. Link state only: `true` does not
 * mean the server is reachable.
 *
 * It is returned synchronously so that a cleanup that runs before the first read has finished (a strict-mode remount)
 * can still dispose it. Until `ready` settles the state is offline, the safe side for a flag that gates writes.
 */
export interface NetworkFlag {
  isOnline(): boolean;
  /** Calls `cb` when the state really changes. Returns an unsubscribe function. */
  onOnlineChange(cb: (online: boolean) => void): () => void;
  /** Settles (never rejects) once the first read has answered, failed or timed out. */
  readonly ready: Promise<void>;
  /** Removes the platform listener and every subscriber. Idempotent. */
  dispose(): void;
}

/** The longest the first read is waited for; a plugin that never answers counts as offline. */
export const NETWORK_READ_TIMEOUT_MS = 3000;

export function openNetworkFlag(network: Network, options: { timers?: TimerPort; timeoutMs?: number } = {}): NetworkFlag {
  const timers = options.timers ?? realTimers;
  let online = false;
  let changed = false;
  let settled = false;
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
        // One subscriber failing must not stop the others from hearing about the change.
      }
    }
  });

  const ready = new Promise<void>((resolve) => {
    const settle = (initial: boolean): void => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (!changed && !disposed) online = initial;
      resolve();
    };
    const timer = timers.setTimeout(() => settle(false), options.timeoutMs ?? NETWORK_READ_TIMEOUT_MS);
    network.online().then(settle, () => {
      settle(false);
    });
  });

  return {
    isOnline: () => online,
    onOnlineChange: (cb) => {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    ready,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      subscribers.clear();
      stopPlatform();
    },
  };
}
