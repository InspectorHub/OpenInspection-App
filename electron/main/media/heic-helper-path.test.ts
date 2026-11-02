import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createHeicHelperPathResolver } from './heic-helper-path.ts';

function fixture(packaged: boolean, expectedHash?: string) {
  const appPath = 'C:\\app\\resources\\app.asar';
  const resourcesPath = 'C:\\app\\resources';
  const helper = new Uint8Array([0x4d, 0x5a, 0, 1]);
  const readFile = vi.fn(async (path: string) => {
    if (path === join(appPath, 'package.json')) return new TextEncoder().encode(JSON.stringify({ oiHeicHelperSha256: expectedHash }));
    if (path === join(resourcesPath, 'heic-helper', 'win-heic-helper.exe')) return helper;
    throw new Error('not found');
  });
  const log = vi.fn();
  return { appPath, resourcesPath, helper, readFile, log, resolver: createHeicHelperPathResolver({
    packaged,
    appPath,
    resourcesPath,
    developmentPath: 'C:\\app\\dist-electron\\native\\win-heic-helper.exe',
    envOverride: undefined,
    readFile,
    log,
  }) };
}

describe('createHeicHelperPathResolver', () => {
  it('uses only the development helper path when unpackaged', async () => {
    const value = fixture(false);
    await expect(value.resolver()).resolves.toBe('C:\\app\\dist-electron\\native\\win-heic-helper.exe');
    expect(value.readFile).not.toHaveBeenCalled();
  });

  it('accepts a development test override only when unpackaged', async () => {
    const value = createHeicHelperPathResolver({
      packaged: false, appPath: 'app', resourcesPath: 'resources', developmentPath: 'dev-helper.exe', envOverride: 'fake.exe',
      readFile: vi.fn(), log: vi.fn(),
    });
    await expect(value()).resolves.toBe('fake.exe');
  });

  it('uses the fixed resource location only after matching the package hash', async () => {
    const bytes = new Uint8Array([0x4d, 0x5a, 0, 1]);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const value = fixture(true, hash);
    await expect(value.resolver()).resolves.toBe(join(value.resourcesPath, 'heic-helper', 'win-heic-helper.exe'));
    await value.resolver();
    expect(value.readFile).toHaveBeenCalledTimes(2);
  });

  it('refuses a missing or mismatched packaged hash and logs a closed code', async () => {
    const missing = fixture(true);
    await expect(missing.resolver()).resolves.toBeNull();
    expect(missing.log).toHaveBeenCalledWith('helper-hash-mismatch');
    const mismatch = fixture(true, '0'.repeat(64));
    await expect(mismatch.resolver()).resolves.toBeNull();
    expect(mismatch.log).toHaveBeenCalledWith('helper-hash-mismatch');
  });
});
