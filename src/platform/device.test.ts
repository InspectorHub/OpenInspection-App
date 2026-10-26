import { describe, expect, it } from 'vitest';
import { DEVICE_ID_KEY, getOrCreateDeviceId } from './device';
import { createMemoryKeyValue } from './kv';

describe('getOrCreateDeviceId', () => {
  it('generates a UUID once and returns the same value afterwards', async () => {
    const store = createMemoryKeyValue();
    const first = await getOrCreateDeviceId(store);
    const second = await getOrCreateDeviceId(store);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toBe(first);
    expect(store.entries()[DEVICE_ID_KEY]).toBe(first);
  });

  it('only calls the generator when nothing is stored', async () => {
    let calls = 0;
    const generate = () => {
      calls += 1;
      return `id-${String(calls)}`;
    };
    const store = createMemoryKeyValue();
    expect(await getOrCreateDeviceId(store, generate)).toBe('id-1');
    expect(await getOrCreateDeviceId(store, generate)).toBe('id-1');
    expect(calls).toBe(1);

    const preset = createMemoryKeyValue({ [DEVICE_ID_KEY]: 'existing' });
    expect(await getOrCreateDeviceId(preset, generate)).toBe('existing');
    expect(calls).toBe(1);
  });

  it('gives different installs different ids', async () => {
    const a = await getOrCreateDeviceId(createMemoryKeyValue());
    const b = await getOrCreateDeviceId(createMemoryKeyValue());
    expect(a).not.toBe(b);
  });
});
