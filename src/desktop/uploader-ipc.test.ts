import { describe, expect, it, vi } from 'vitest';
import type { UploaderStartOptions } from '../../electron/shared/ipc-contract.ts';
import { createDesktopUploaderPlugin } from './uploader-ipc.ts';

describe('desktop uploader adapter', () => {
  it('maps uploader methods and delivers only its own event subscriptions', async () => {
    const listeners = new Set<(event: { name: string; id: string }) => void>();
    const bridge = { uploader: {
      start: vi.fn(async () => ({ id: 'upload-1' })),
      remove: vi.fn(async () => undefined),
      onEvent: (listener: (event: { name: string; id: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    } } as never;
    const plugin = createDesktopUploaderPlugin(bridge);
    await expect(plugin.startUpload({ filePath: 'file:///media/a.jpg', serverUrl: 'https://engine.example', method: 'POST', uploadType: 'multipart', fileField: 'file', mimeType: 'image/jpeg', maxRetries: 0, headers: {}, notificationTitle: 'Uploading' })).resolves.toEqual({ id: 'upload-1' });
    await plugin.removeUpload({ id: 'upload-1' });
    const received: unknown[] = [];
    const subscription = await plugin.addListener('events', (event) => received.push(event));
    for (const listener of listeners) listener({ name: 'completed', id: 'upload-1' });
    await subscription.remove();
    expect(received).toEqual([{ name: 'completed', id: 'upload-1' }]);
    await expect(plugin.acknowledgeEvent({ eventId: 'ignored' })).resolves.toBeUndefined();
  });

  it('normalizes client header names for the strict Windows upload host', async () => {
    const start = vi.fn(async (_options: UploaderStartOptions) => ({ id: 'upload-1' }));
    const bridge = { uploader: { start, remove: vi.fn(), onEvent: vi.fn(() => vi.fn()) } } as never;
    const plugin = createDesktopUploaderPlugin(bridge);
    await plugin.startUpload({ filePath: 'file:///media/a.jpg', serverUrl: 'http://127.0.0.1:1234/upload', method: 'POST', uploadType: 'multipart', fileField: 'file', mimeType: 'image/jpeg', maxRetries: 0, headers: { 'X-Client-Platform': 'windows', 'X-Client-Version': '0.1.1' }, notificationTitle: 'Uploading' });
    expect(start.mock.calls[0]?.[0].headers).toEqual({ 'x-client-platform': 'windows', 'x-client-version': '0.1.1' });
  });
});
