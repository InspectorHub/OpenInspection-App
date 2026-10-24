import { describe, expect, it } from 'vitest';
import { createMemoryKeyValue } from './kv';
import { INSTALL_MARKER_KEY, initSecureStore, type SecureStorageLike } from './secure-store';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const log: string[] = [];
  const storage: SecureStorageLike = {
    getItem: (k) => Promise.resolve(map.get(k) ?? null),
    setItem: (k, v) => {
      log.push(`set:${k}`);
      map.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
    clear: () => {
      log.push('clear');
      map.clear();
      return Promise.resolve();
    },
  };
  return { storage, map, log };
}

describe('initSecureStore install marker', () => {
  it('wipes stale keys on a fresh install, then writes the marker', async () => {
    const { storage, map, log } = fakeStorage({ 'refresh-token': 'stale-from-previous-install' });
    const markers = createMemoryKeyValue();
    const store = await initSecureStore(storage, markers);
    expect(log).toEqual(['clear']);
    expect(map.size).toBe(0);
    expect(await store.get('refresh-token')).toBeNull();
    expect(markers.entries()[INSTALL_MARKER_KEY]).toBeDefined();
  });

  it('keeps stored items when the marker is already present', async () => {
    const { storage, log } = fakeStorage({ 'refresh-token': 'keep-me' });
    const markers = createMemoryKeyValue({ [INSTALL_MARKER_KEY]: '1' });
    const store = await initSecureStore(storage, markers);
    expect(log).toEqual([]);
    expect(await store.get('refresh-token')).toBe('keep-me');
  });

  it('only wipes once across launches', async () => {
    const { storage, log } = fakeStorage();
    const markers = createMemoryKeyValue();
    const first = await initSecureStore(storage, markers);
    await first.set('refresh-token', 'fresh');
    const second = await initSecureStore(storage, markers);
    expect(log.filter((l) => l === 'clear')).toHaveLength(1);
    expect(await second.get('refresh-token')).toBe('fresh');
  });

  it('round-trips set, get and remove', async () => {
    const { storage } = fakeStorage();
    const store = await initSecureStore(storage, createMemoryKeyValue());
    await store.set('k', 'v');
    expect(await store.get('k')).toBe('v');
    await store.remove('k');
    expect(await store.get('k')).toBeNull();
  });
});
