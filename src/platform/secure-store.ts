import type { KeyValue } from './kv';

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The subset of the secure-storage plugin the adapter uses. */
export interface SecureStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  clear(): Promise<void>;
}

export const INSTALL_MARKER_KEY = 'oi.install-marker';
const INSTALL_MARKER_VALUE = '1';

/**
 * Wraps the plugin and performs the first-launch cleanup.
 *
 * The iOS keychain survives an uninstall, so entries from a previous install
 * would otherwise be read by a fresh one. Preferences are wiped with the app,
 * so a missing marker means "fresh install": clear every stale keychain item,
 * then write the marker. A present marker means a normal launch: keep items.
 */
export function initSecureStore(storage: SecureStorageLike, markers: KeyValue): Promise<SecureStore> {
  const existing = initialising.get(storage);
  if (existing) return existing;
  const started = runInit(storage, markers);
  initialising.set(storage, started);
  started.catch(() => initialising.delete(storage));
  return started;
}

/**
 * One initialisation per storage object: concurrent callers share it, so a
 * second caller can never run the fresh-install wipe after the first one has
 * already written. A failed initialisation is forgotten so it can be retried.
 */
const initialising = new WeakMap<SecureStorageLike, Promise<SecureStore>>();

async function runInit(storage: SecureStorageLike, markers: KeyValue): Promise<SecureStore> {
  const marker = await markers.get(INSTALL_MARKER_KEY);
  if (marker === null) {
    await storage.clear();
    await markers.set(INSTALL_MARKER_KEY, INSTALL_MARKER_VALUE);
  }
  return {
    get: (key) => storage.getItem(key),
    set: (key, value) => storage.setItem(key, value),
    remove: (key) => storage.removeItem(key),
  };
}
