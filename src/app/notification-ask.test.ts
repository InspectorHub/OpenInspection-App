import { describe, expect, it, vi } from 'vitest';
import { createMemoryKeyValue, type KeyValue } from '../platform/kv';
import type { NotificationPermissionPort, NotificationState } from '../platform/notifications';
import { ASK_KEY, createNotificationAsk } from './notification-ask';

function port(check: NotificationState, request: NotificationState = check): NotificationPermissionPort & { request: ReturnType<typeof vi.fn> } {
  return { check: vi.fn(() => Promise.resolve(check)), request: vi.fn(() => Promise.resolve(request)) } as never;
}

describe('notification ask', () => {
  it('explains once on Android when the permission is still open and the person was never asked', async () => {
    const ask = createNotificationAsk({ kv: createMemoryKeyValue(), permission: port('prompt') });
    expect(await ask.shouldExplain()).toBe(true);
  });

  it.each<NotificationState>(['granted', 'denied', 'unsupported'])('does not explain when the system already answered (%s)', async (state) => {
    const ask = createNotificationAsk({ kv: createMemoryKeyValue(), permission: port(state) });
    expect(await ask.shouldExplain()).toBe(false);
  });

  it('accepting shows the system prompt once and remembers that the person was asked', async () => {
    const kv = createMemoryKeyValue();
    const permission = port('prompt', 'granted');
    const ask = createNotificationAsk({ kv, permission });
    expect(await ask.accept()).toBe('granted');
    expect(permission.request).toHaveBeenCalledTimes(1);
    expect(kv.entries()[ASK_KEY]).toBe('asked');
    expect(await ask.shouldExplain()).toBe(false);
  });

  it('a system refusal is remembered and never asked again', async () => {
    const kv = createMemoryKeyValue();
    const ask = createNotificationAsk({ kv, permission: port('prompt', 'denied') });
    expect(await ask.accept()).toBe('denied');
    expect(await createNotificationAsk({ kv, permission: port('prompt') }).shouldExplain()).toBe(false);
  });

  it('"Not now" is remembered on this device and never asked again (control: before it, the explanation was due)', async () => {
    const kv = createMemoryKeyValue();
    const permission = port('prompt');
    expect(await createNotificationAsk({ kv, permission }).shouldExplain()).toBe(true);
    await createNotificationAsk({ kv, permission }).decline();
    expect(kv.entries()[ASK_KEY]).toBe('declined');
    expect(await createNotificationAsk({ kv, permission }).shouldExplain()).toBe(false);
    expect(permission.request).not.toHaveBeenCalled();
  });

  it('when the memory cannot be read nothing is asked (a prompt that cannot be remembered would repeat)', async () => {
    const broken: KeyValue = { get: () => Promise.reject(new Error('storage')), set: () => Promise.resolve() };
    expect(await createNotificationAsk({ kv: broken, permission: port('prompt') }).shouldExplain()).toBe(false);
  });

  it('when the memory cannot be written the answer still comes back and nothing throws', async () => {
    const broken: KeyValue = { get: () => Promise.resolve(null), set: () => Promise.reject(new Error('storage')) };
    const ask = createNotificationAsk({ kv: broken, permission: port('prompt', 'granted') });
    expect(await ask.accept()).toBe('granted');
    await expect(ask.decline()).resolves.toBeUndefined();
  });

  it('the person can still turn notifications on from Settings after "Not now" (request does not look at the memory)', async () => {
    const kv = createMemoryKeyValue({ [ASK_KEY]: 'declined' });
    const permission = port('prompt', 'granted');
    expect(await createNotificationAsk({ kv, permission }).accept()).toBe('granted');
    expect(permission.request).toHaveBeenCalledTimes(1);
  });
});
