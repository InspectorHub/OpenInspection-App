import { describe, expect, it, vi } from 'vitest';
import { createDesktopKeyValue } from './kv-ipc.ts';

describe('createDesktopKeyValue', () => {
  it('delegates the KeyValue contract to the bridge', async () => {
    const bridge = { get: vi.fn(async () => 'dark'), set: vi.fn(async () => {}) };
    const kv = createDesktopKeyValue({ kv: bridge });
    await expect(kv.get('theme')).resolves.toBe('dark');
    await kv.set('theme', 'light');
    expect(bridge.get).toHaveBeenCalledWith('theme');
    expect(bridge.set).toHaveBeenCalledWith('theme', 'light');
  });
});
