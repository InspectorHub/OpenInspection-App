import { describe, expect, it } from 'vitest';
import { connectToServer } from './connect';
import { createWorld } from './test-support/world';

describe('composition', () => {
  it('sends the client platform and version on every request', async () => {
    const world = await createWorld({ appVersion: '2.3.4' });
    await connectToServer(world.services, world.server.origin);
    expect(world.server.requests.length).toBeGreaterThan(0);
    for (const request of world.server.requests) {
      expect(request.headers['x-client-platform']).toBe('android');
      expect(request.headers['x-client-version']).toBe('2.3.4');
    }
  });

  it.each(['windows', 'android'] as const)('sends X-Client-Platform %s when composed for it', async (platform) => {
    const world = await createWorld({ platform, appVersion: '2.3.4' });
    await connectToServer(world.services, world.server.origin);
    expect(world.server.requests.length).toBeGreaterThan(0);
    for (const request of world.server.requests) {
      expect(request.headers['x-client-platform']).toBe(platform);
      expect(request.headers['x-client-version']).toBe('2.3.4');
    }
  });
});
