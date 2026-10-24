import type { SecureStore } from '../../platform/secure-store';

export interface MemorySecureStore extends SecureStore {
  entries(): Record<string, string>;
  /** Every operation recorded as `set:key` or `remove:key`, in call order. */
  log: string[];
  /** Makes every later `set` reject until `failSet(false)`. */
  failSet(on: boolean): void;
}

/** An in-memory `SecureStore` for tests, with write-failure injection. */
export function createMemorySecureStore(initial: Record<string, string> = {}): MemorySecureStore {
  const map = new Map(Object.entries(initial));
  const log: string[] = [];
  let failing = false;
  return {
    log,
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      log.push(`set:${key}`);
      if (failing) return Promise.reject(new Error('secure store write failed'));
      map.set(key, value);
      return Promise.resolve();
    },
    remove: (key) => {
      log.push(`remove:${key}`);
      map.delete(key);
      return Promise.resolve();
    },
    entries: () => Object.fromEntries(map),
    failSet: (on) => {
      failing = on;
    },
  };
}
