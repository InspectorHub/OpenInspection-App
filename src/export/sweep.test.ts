import { describe, expect, it } from 'vitest';
import { exportFileName } from './format';
import { sweepStaleExports } from './sweep';
import { NOW, createExportFiles } from './test-support/world';

const MINUTE = 60_000;

describe('sweeping exports left behind', () => {
  it('removes an export older than the bound and keeps a newer one', async () => {
    const files = createExportFiles();
    files.seedCache(exportFileName(NOW - 30 * MINUTE));
    files.seedCache(exportFileName(NOW - 1 * MINUTE));
    const result = await sweepStaleExports(files, NOW, 15 * MINUTE);
    expect(result).toEqual({ removed: 1, failed: 0 });
    expect(files.cacheNames()).toEqual([exportFileName(NOW - 1 * MINUTE)]);
  });

  it('with a bound of zero removes every export, which is what the start of an export does', async () => {
    const files = createExportFiles();
    files.seedCache(exportFileName(NOW - 1));
    files.seedCache(exportFileName(NOW));
    await sweepStaleExports(files, NOW, 0);
    expect(files.cacheNames()).toEqual([]);
  });

  it('touches only names it wrote: the prefix, a timestamp and .zip', async () => {
    const files = createExportFiles();
    const others = ['inspectorhub-export-.zip', 'inspectorhub-export-abc.zip', 'inspectorhub-export-1700000000000.zip.bak', 'xinspectorhub-export-1700000000000.zip', 'photo.jpg', 'inspectorhub-export-1700000000000.txt'];
    for (const name of others) files.seedCache(name);
    files.seedCache('inspectorhub-export-1700000000000.zip');
    const result = await sweepStaleExports(files, NOW, 0);
    expect(result.removed).toBe(1);
    expect(files.cacheNames().sort()).toEqual([...others].sort());
  });

  it('treats an export dated in the future (a clock that moved back) as stale', async () => {
    const files = createExportFiles();
    files.seedCache(exportFileName(NOW + 10 * 24 * 60 * MINUTE));
    await sweepStaleExports(files, NOW, 15 * MINUTE);
    expect(files.cacheNames()).toEqual([]);
  });

  it('counts a file it could not delete and goes on with the rest', async () => {
    const files = createExportFiles();
    files.seedCache(exportFileName(NOW - 40 * MINUTE));
    files.seedCache(exportFileName(NOW - 50 * MINUTE));
    const real = files.removeCache;
    files.removeCache = (name) => (name === exportFileName(NOW - 40 * MINUTE) ? Promise.reject(new Error('locked')) : real(name));
    expect(await sweepStaleExports(files, NOW, 15 * MINUTE)).toEqual({ removed: 1, failed: 1 });
  });

  it('never throws when the cache cannot be listed', async () => {
    const files = createExportFiles();
    files.listCache = () => Promise.reject(new Error('io'));
    expect(await sweepStaleExports(files, NOW, 0)).toEqual({ removed: 0, failed: 0 });
  });
});
