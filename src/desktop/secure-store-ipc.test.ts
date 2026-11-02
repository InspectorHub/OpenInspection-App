import { describe, expect, it, vi } from 'vitest';
import { createDesktopSecureStore } from './secure-store-ipc.ts';

describe('createDesktopSecureStore', () => {
  it('delegates the SecureStore contract directly to the bridge without install marker operations', async () => {
    const bridge = { get: vi.fn(async () => 'secret'), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) };
    const store = createDesktopSecureStore({ secrets: bridge });
    await expect(store.get('refresh-token')).resolves.toBe('secret');
    await store.set('refresh-token', 'next');
    await store.remove('refresh-token');
    expect(bridge.get).toHaveBeenCalledWith('refresh-token');
    expect(bridge.set).toHaveBeenCalledWith('refresh-token', 'next');
    expect(bridge.remove).toHaveBeenCalledWith('refresh-token');
    expect(bridge.get).toHaveBeenCalledTimes(1);
  });
});
