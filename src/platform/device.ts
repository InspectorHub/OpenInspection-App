import type { KeyValue } from './kv';

export const DEVICE_ID_KEY = 'oi.device-id';

/**
 * Returns this install's device id, generating a random UUID on first use.
 * The id is self-generated and stored by the app; it is deliberately not read
 * from the OS (`Device.getId()` can change).
 */
export async function getOrCreateDeviceId(
  store: KeyValue,
  generate: () => string = () => crypto.randomUUID(),
): Promise<string> {
  const existing = await store.get(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = generate();
  await store.set(DEVICE_ID_KEY, id);
  return id;
}
