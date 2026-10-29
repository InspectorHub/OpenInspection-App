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
    const services = await composeDesktop({} as DesktopBridge);
    expect(services.platform).toBe('windows');
    await services.http.request({ url: 'https://example.test/ping', method: 'GET' });
    await services.refreshCompat('https://example.test');
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(new Headers(request.headers).get('X-Client-Platform')).toBe('windows');
    expect(await services.notifications.check()).toBe('unsupported');
  });
});
