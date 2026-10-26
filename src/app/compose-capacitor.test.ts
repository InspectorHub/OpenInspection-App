import { describe, expect, it, vi } from 'vitest';
import { composeReal, toClientPlatform } from './compose-capacitor';
import { createWorld } from './test-support/world';

describe('composeReal', () => {
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

  it('wires the real sharer, not the build-time default that refuses to share', async () => {
    const world = await createWorld();
    const services = await composeReal({ openDb: () => Promise.resolve(world.db), closeDb: () => Promise.resolve(), openStore: () => Promise.resolve(world.store) });
    const outcome = await services.sharer.share('file:///export.json').then(
      () => 'shared',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(outcome).not.toBe('This build cannot share files');
  });
});
