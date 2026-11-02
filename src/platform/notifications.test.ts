import { describe, expect, it, vi } from 'vitest';
import { createNotificationPermission, type NotificationPluginLike } from './notifications';

function plugin(check: string, request: string = check): NotificationPluginLike & { checkPermissions: ReturnType<typeof vi.fn>; requestPermissions: ReturnType<typeof vi.fn> } {
  return {
    checkPermissions: vi.fn(() => Promise.resolve({ display: check })),
    requestPermissions: vi.fn(() => Promise.resolve({ display: request })),
  } as never;
}

describe('createNotificationPermission', () => {
  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['prompt', 'prompt'],
    ['prompt-with-rationale', 'prompt'],
  ])('reads the plugin answer %s as %s on Android', async (raw, expected) => {
    expect(await createNotificationPermission(plugin(raw), 'android').check()).toBe(expected);
  });

  it('treats an answer it does not know as denied, never as granted', async () => {
    expect(await createNotificationPermission(plugin('something-new'), 'android').check()).toBe('denied');
    expect(await createNotificationPermission({ checkPermissions: () => Promise.resolve({}), requestPermissions: () => Promise.resolve({}) } as never, 'android').check()).toBe('denied');
  });

  it('request asks the plugin and returns what the person answered', async () => {
    const p = plugin('prompt', 'granted');
    const port = createNotificationPermission(p, 'android');
    expect(await port.request()).toBe('granted');
    expect(p.requestPermissions).toHaveBeenCalledTimes(1);
    expect(p.checkPermissions).not.toHaveBeenCalled();
  });

  it('is unsupported off Android and never touches the plugin there (control: Android does)', async () => {
    const p = plugin('prompt');
    const ios = createNotificationPermission(p, 'ios');
    expect(await ios.check()).toBe('unsupported');
    expect(await ios.request()).toBe('unsupported');
    const windows = createNotificationPermission(p, 'windows');
    expect(await windows.check()).toBe('unsupported');
    expect(await windows.request()).toBe('unsupported');
    expect(p.checkPermissions).not.toHaveBeenCalled();
    expect(p.requestPermissions).not.toHaveBeenCalled();
    await createNotificationPermission(p, 'android').check();
    expect(p.checkPermissions).toHaveBeenCalledTimes(1);
  });

  it('a plugin that fails reads as unsupported, so nothing nags and nothing throws', async () => {
    const failing: NotificationPluginLike = { checkPermissions: () => Promise.reject(new Error('no plugin')), requestPermissions: () => Promise.reject(new Error('no plugin')) };
    const port = createNotificationPermission(failing, 'android');
    expect(await port.check()).toBe('unsupported');
    expect(await port.request()).toBe('unsupported');
    const throwing: NotificationPluginLike = {
      checkPermissions: () => {
        throw new Error('sync');
      },
      requestPermissions: () => {
        throw new Error('sync');
      },
    };
    expect(await createNotificationPermission(throwing, 'android').check()).toBe('unsupported');
  });
});
