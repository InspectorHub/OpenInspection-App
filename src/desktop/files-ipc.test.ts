import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesHost } from '../../electron/main/data/files-host.ts';
import { createDesktopFiles } from './files-ipc.ts';
import { describeFilesContract } from '../platform/test-support/files-contract.ts';

describe('createDesktopFiles', () => {
  let root: string;
  let host: ReturnType<typeof createFilesHost>;
  let files: ReturnType<typeof createDesktopFiles>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oi-desktop-files-'));
    host = createFilesHost({ fs: await import('node:fs/promises'), mediaRoot: join(root, 'media'), cacheRoot: join(root, 'cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    files = createDesktopFiles({ files: host });
  });
  afterEach(async () => { await host?.dispose(); await rm(root, { recursive: true, force: true }); });
  describeFilesContract(() => files);
  it('reconstructs a media stream through IPC and returns its file URI', async () => {
    async function* chunks() { yield Uint8Array.from([0xff, 0xd8]); yield Uint8Array.from([0xff, 1]); }
    await expect(files.writeStream('media/a.jpg', chunks())).resolves.toMatch(/^file:\/\//);
    expect(await files.read('media/a.jpg')).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 1]));
  });
  it('reconstructs cache chunks through the cache stream area', async () => {
    async function* chunks() { yield Uint8Array.from([1, 2]); yield Uint8Array.from([3]); }
    await files.writeCacheChunks('export.zip', chunks());
    expect(await files.listCache()).toEqual([{ name: 'export.zip', mtimeMs: expect.any(Number) }]);
    await files.removeCache('export.zip');
    expect(await files.listCache()).toEqual([]);
  });
  it('aborts a partial stream after an iterator failure', async () => {
    async function* broken() { yield Uint8Array.from([0xff, 0xd8, 0xff]); throw new Error('stream broke'); }
    await expect(files.writeStream('media/broken.jpg', broken())).rejects.toThrow('stream broke');
    expect(await files.list('')).toEqual([]);
  });
});
