import { describe, expect, it, vi } from 'vitest';
import { createBrowserNetwork } from './network-browser.ts';

describe('desktop browser network adapter', () => {
  it('reads browser link state and maps online/offline events until unsubscribed', async () => {
    const listeners = new Map<string, Set<() => void>>();
    let onLine = true;
    const win = {
      navigator: { get onLine() { return onLine; } },
      addEventListener: vi.fn((name: string, cb: () => void) => { const set = listeners.get(name) ?? new Set(); set.add(cb); listeners.set(name, set); }),
      removeEventListener: vi.fn((name: string, cb: () => void) => listeners.get(name)?.delete(cb)),
    };
    const network = createBrowserNetwork(win);
    expect(await network.online()).toBe(true);
    const changes = vi.fn();
    const unsubscribe = network.onChange(changes);
    onLine = false;
    for (const listener of listeners.get('offline') ?? []) listener();
    onLine = true;
    for (const listener of listeners.get('online') ?? []) listener();
    unsubscribe(); unsubscribe();
    for (const listener of listeners.get('offline') ?? []) listener();
    expect(changes.mock.calls).toEqual([[false], [true]]);
    expect(await network.online()).toBe(true);
    expect(win.removeEventListener).toHaveBeenCalledTimes(2);
  });
});
