import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_VOLUME_BYTES,
  checkFreeSpace,
  dataPackageDir,
  freeSpaceBytes,
  isVolumeName,
  resolveVolumePath,
  type StatFsLike,
} from './disk';

describe('data-package disk: volume path safety', () => {
  const dir = 'D:/userData/data-package';

  it('accepts only the fixed root volume and numbered media volumes', () => {
    expect(isVolumeName('package.zip')).toBe(true);
    expect(isVolumeName('media-001.zip')).toBe(true);
    expect(isVolumeName('media-99999.zip')).toBe(true);
    for (const bad of ['../evil.zip', 'a/b.zip', 'package.ZIP', 'media-0.zip', 'media-100000.zip', 'media-abc.zip', '', 'package.zip/../x']) {
      expect(isVolumeName(bad)).toBe(false);
    }
  });

  it('resolves accepted volume names under the data-package dir and refuses anything else', () => {
    expect(resolveVolumePath(dir, 'package.zip')).toBe(resolve(dir, 'package.zip'));
    expect(resolveVolumePath(dir, 'media-007.zip')).toBe(resolve(dir, 'media-007.zip'));
    expect(() => resolveVolumePath(dir, '../evil.zip')).toThrow();
    expect(() => resolveVolumePath(dir, 'secret.txt')).toThrow();
  });

  it('keeps the client volume cap below ZIP64 and at 1 GiB', () => {
    expect(CLIENT_VOLUME_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('puts state inside a dedicated data-package directory', () => {
    expect(dataPackageDir('D:/userData')).toBe(resolve('D:/userData', 'data-package'));
  });
});

describe('data-package disk: free-space check', () => {
  const stat = (available: number, bsize = 4096): StatFsLike => ({
    statfs: async () => ({ bavail: Math.floor(available / bsize), bsize }),
  });

  it('reports enough when available bytes meet the requirement', async () => {
    expect(await checkFreeSpace(stat(2 * 1024 ** 3), 'D:/x', 1024 ** 3)).toEqual({ kind: 'enough' });
  });

  it('reports insufficient with the shortfall when space is low', async () => {
    const result = await checkFreeSpace(stat(100), 'D:/x', 1000);
    expect(result.kind).toBe('insufficient');
    if (result.kind === 'insufficient') expect(result.availableBytes).toBeLessThan(result.requiredBytes);
  });

  it('reports raw free bytes and null on failure', async () => {
    expect(await freeSpaceBytes(stat(2 * 1024 ** 3), 'D:/x')).toBe(2 * 1024 ** 3);
    const failing: StatFsLike = { statfs: async () => { throw new Error('no statfs'); } };
    expect(await freeSpaceBytes(failing, 'D:/x')).toBeNull();
  });

  it('is conservative when statfs fails or returns nonsense', async () => {
    const failing: StatFsLike = { statfs: async () => { throw new Error('no statfs'); } };
    expect((await checkFreeSpace(failing, 'D:/x', 1)).kind).toBe('unknown');
    expect((await checkFreeSpace(stat(-1), 'D:/x', 1)).kind).toBe('unknown');
  });
});
