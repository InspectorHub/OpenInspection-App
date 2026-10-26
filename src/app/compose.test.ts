import { describe, expect, it, vi } from 'vitest';
import { connectToServer } from './connect';
import { composeReal, toClientPlatform } from './compose';
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

  it('closes the database when the secure store cannot be opened, and rethrows the store error', async () => {
    const world = await createWorld();
    const closeDb = vi.fn(() => Promise.resolve());
    const failure = new Error('keystore unavailable');
    await expect(composeReal({ openDb: () => Promise.resolve(world.db), closeDb, openStore: () => Promise.reject(failure) })).rejects.toBe(failure);
    expect(closeDb).toHaveBeenCalledTimes(1);
  });

  it('a close that itself fails does not hide the store error', async () => {
    const world = await createWorld();
    const failure = new Error('keystore unavailable');
    await expect(
      composeReal({ openDb: () => Promise.resolve(world.db), closeDb: () => Promise.reject(new Error('close failed')), openStore: () => Promise.reject(failure) }),
    ).rejects.toBe(failure);
  });

  it('control: when both open, nothing is closed until the services are told to', async () => {
    const world = await createWorld();
    const closeDb = vi.fn(() => Promise.resolve());
    const services = await composeReal({ openDb: () => Promise.resolve(world.db), closeDb, openStore: () => Promise.resolve(world.store) });
    expect(closeDb).not.toHaveBeenCalled();
    await services.close();
    expect(closeDb).toHaveBeenCalledTimes(1);
  });
});
