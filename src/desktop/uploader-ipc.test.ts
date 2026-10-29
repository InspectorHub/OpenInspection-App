import { describe, expect, it, vi } from 'vitest';
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
});
