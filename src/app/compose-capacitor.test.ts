import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { composeReal, toClientPlatform } from './compose-capacitor';
import { createWorld } from './test-support/world';

describe('the Capacitor entry', () => {
  // Electron has its own entry (main-electron.tsx, composeDesktop); the Android and iOS bundle must not carry the desktop IPC modules.
  it.each(['./compose-capacitor.ts', '../main.tsx'])('%s imports nothing from the desktop client', (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).toContain("from '@capacitor/");
    expect(source).not.toMatch(/from '[^']*\/desktop\//);
    expect(source).not.toContain('oiDesktop');
  });

  // OpenFailed is shared with the desktop build and reads the preload bridge off `window`; it must not import the desktop module.
  it('the shared blocking screens import nothing from the desktop client', () => {
    const source = readFileSync(new URL('../ui/Blocking.tsx', import.meta.url), 'utf8');
    expect(source).toContain('window.oiDesktop');
    expect(source).not.toMatch(/from '[^']*\/desktop\//);
  });
});

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
