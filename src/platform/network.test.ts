import { describe, expect, it } from 'vitest';
import { createNetwork, type NetworkPluginLike } from './network';

function fakePlugin(connected: boolean) {
  const listeners = new Set<(s: { connected: boolean }) => void>();
  let removed = 0;
  const plugin: NetworkPluginLike = {
    getStatus: () => Promise.resolve({ connected }),
    addListener: (_event, listener) => {
      listeners.add(listener);
      return Promise.resolve({
        remove: () => {
          listeners.delete(listener);
          removed += 1;
          return Promise.resolve();
        },
      });
    },
  };
  return {
    plugin,
    emit: (c: boolean) => listeners.forEach((l) => l({ connected: c })),
    listenerCount: () => listeners.size,
    removed: () => removed,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('createNetwork', () => {
  it('maps plugin status to link state', async () => {
    expect(await createNetwork(fakePlugin(true).plugin).online()).toBe(true);
    expect(await createNetwork(fakePlugin(false).plugin).online()).toBe(false);
  });

  it('reports changes to the callback', async () => {
    const f = fakePlugin(true);
    const seen: boolean[] = [];
    createNetwork(f.plugin).onChange((o) => seen.push(o));
    await settle();
    f.emit(false);
    f.emit(true);
    expect(seen).toEqual([false, true]);
  });

  it('stops delivering and removes the plugin listener after unsubscribe', async () => {
    const f = fakePlugin(true);
    const seen: boolean[] = [];
    const off = createNetwork(f.plugin).onChange((o) => seen.push(o));
    await settle();
    expect(f.listenerCount()).toBe(1);
    off();
    await settle();
    f.emit(false);
    expect(seen).toEqual([]);
    expect(f.listenerCount()).toBe(0);
    expect(f.removed()).toBe(1);
  });

  it('unsubscribing before the listener is registered still cleans up', async () => {
    const f = fakePlugin(true);
    const seen: boolean[] = [];
    const off = createNetwork(f.plugin).onChange((o) => seen.push(o));
    off();
    await settle();
    f.emit(false);
    expect(seen).toEqual([]);
    expect(f.listenerCount()).toBe(0);
  });
});
