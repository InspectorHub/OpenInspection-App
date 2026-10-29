import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKvHost } from './kv.ts';
import type { FsLike } from './secrets.ts';

const directories: string[] = [];
async function file(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oi-kv-'));
  directories.push(dir);
  return join(dir, 'settings.json');
}
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('createKvHost', () => {
  it('persists values across host reloads and uses an atomic temp file rename', async () => {
    const path = await file();
    const fs = (await import('node:fs/promises')) as unknown as FsLike;
    await createKvHost({ fs, file: path }).set('theme', 'dark');
    await expect(createKvHost({ fs, file: path }).get('theme')).resolves.toBe('dark');
    await expect(readFile(path, 'utf8')).resolves.toContain('dark');
    await expect(readdir(join(path, '..'))).resolves.toEqual(['settings.json']);
  });

  it('keeps the previous JSON document when rename fails', async () => {
    const path = await file();
    const fs = (await import('node:fs/promises')) as unknown as FsLike;
    await createKvHost({ fs, file: path }).set('theme', 'dark');
    const failingFs: FsLike = { ...fs, rename: async () => { throw new Error('rename failed'); } };
    await expect(createKvHost({ fs: failingFs, file: path }).set('theme', 'light')).rejects.toThrow('rename failed');
    await expect(createKvHost({ fs, file: path }).get('theme')).resolves.toBe('dark');
  });

  it('rejects invalid keys and values over 64 KiB', async () => {
    const path = await file();
    const host = createKvHost({ fs: (await import('node:fs/promises')) as unknown as FsLike, file: path });
    for (const key of ['', '..\\escape', 'x'.repeat(257), 'contains space']) await expect(host.get(key)).rejects.toThrow();
    await expect(host.set('valid', 'x'.repeat(65_537))).rejects.toThrow();
  });

  it('accepts a value of exactly 64 KiB', async () => {
    const path = await file();
    const host = createKvHost({ fs: (await import('node:fs/promises')) as unknown as FsLike, file: path });
    const value = 'x'.repeat(64 * 1024);
    await host.set('maximum', value);
    await expect(host.get('maximum')).resolves.toBe(value);
  });
});
