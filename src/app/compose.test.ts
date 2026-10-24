import { describe, expect, it } from 'vitest';
import { connectToServer } from './connect';
import { toClientPlatform } from './compose';
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

  it('reports anything but iOS as Android, including the development browser', () => {
    expect(toClientPlatform('ios')).toBe('ios');
    expect(toClientPlatform('android')).toBe('android');
    expect(toClientPlatform('web')).toBe('android');
  });
});
