import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge } from '../../electron/shared/ipc-contract';
import { composeDesktop } from './compose-desktop';

afterEach(() => vi.unstubAllGlobals());

describe('composeDesktop', () => {
  it('sends the Windows platform header on direct and compatibility requests', async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const services = await composeDesktop({ media: {} } as unknown as DesktopBridge);
    expect(services.platform).toBe('windows');
    await services.http.request({ url: 'https://example.test/ping', method: 'GET' });
    await services.refreshCompat('https://example.test');
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(new Headers(request.headers).get('X-Client-Platform')).toBe('windows');
    expect(await services.notifications.check()).toBe('unsupported');
  });

  it('makes the Windows decoder available to the editor services', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff]);
    const decodeHeic = vi.fn(async () => ({ ok: true as const, jpeg }));
    const services = await composeDesktop({ media: { decodeHeic } } as unknown as DesktopBridge);
    const heic = Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);

    const decoded = await services.decodeImage?.(new Blob([heic]), { maxLongEdge: 1920 });

    expect(decodeHeic).toHaveBeenCalledOnce();
    expect(decoded?.blob.type).toBe('image/jpeg');
  });

  it('offers the pictures folder as the place a copy of a photo can be saved, through the bridge', async () => {
    const save = vi.fn(async () => 'saved' as const);
    const services = await composeDesktop({ media: {}, gallery: { save } } as unknown as DesktopBridge);
    expect(services.photoGallery.available()).toBe(true);
    const result = await services.photoGallery.save(new Blob([Uint8Array.from([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }), { name: 'InspectorHub-20261102-101500-ab12cd34.jpg', createdAt: 0 });
    expect(result).toBe('saved');
    expect(save).toHaveBeenCalledWith('InspectorHub-20261102-101500-ab12cd34.jpg', expect.any(Uint8Array));
  });

  it('keeps the optional editor decoder absent when preload does not expose the bridge method', async () => {
    const services = await composeDesktop({ media: {} } as unknown as DesktopBridge);
    expect(services.decodeImage).toBeUndefined();
  });
});
