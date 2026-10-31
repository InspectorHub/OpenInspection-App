import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSecretsHost, ensureSecretsDirectory, SecretUnreadableError, SecretsUnavailableError, type FsLike, type SafeStorageLike } from './secrets.ts';

const directories: string[] = [];
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oi-secrets-'));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function storage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.concat([Buffer.from('enc:'), Buffer.from(value, 'utf8').reverse()]),
    decryptString: (value) => {
      if (!value.subarray(0, 4).equals(Buffer.from('enc:'))) throw new Error('bad ciphertext');
      return Buffer.from(value.subarray(4)).reverse().toString('utf8');
    },
  };
}

describe('createSecretsHost', () => {
  it('writes encrypted bytes without plaintext or plaintext base64 and reads them after a host reload', async () => {
    const dir = await directory();
    const first = createSecretsHost({ safeStorage: storage(), fs: (await import('node:fs/promises')) as unknown as FsLike, dir });
    const value = 'sensitive-value-7f2a';
    await first.set('refresh-token', value);
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const bytes = await readFile(join(dir, files[0]!));
    expect(bytes.includes(Buffer.from(value))).toBe(false);
    expect(bytes.toString('utf8')).not.toContain(Buffer.from(value).toString('base64'));
    const second = createSecretsHost({ safeStorage: storage(), fs: (await import('node:fs/promises')) as unknown as FsLike, dir });
    await expect(second.get('refresh-token')).resolves.toBe(value);
  });

  it('rejects writes when safeStorage is unavailable without creating files', async () => {
    const dir = await directory();
    const fs = (await import('node:fs/promises')) as unknown as FsLike;
    const host = createSecretsHost({ safeStorage: storage(false), fs, dir });
    expect(host.available).toBe(false);
    await expect(host.set('token', 'plaintext')).rejects.toBeInstanceOf(SecretsUnavailableError);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('rejects reads before touching disk when safeStorage is unavailable, even for a missing key', async () => {
    const readFile = vi.fn(async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
    const fs = { readFile } as unknown as FsLike;
    const host = createSecretsHost({ safeStorage: storage(false), fs, dir: 'secrets' });
    await expect(host.get('missing')).rejects.toBeInstanceOf(SecretsUnavailableError);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('refuses a secrets directory that is a reparse point without creating or reading through it', async () => {
    const operations: string[] = [];
    const fs = {
      lstat: async () => ({ isSymbolicLink: () => true }),
      mkdir: async () => { operations.push('mkdir'); },
      readFile: async () => { operations.push('readFile'); throw new Error('unexpected'); },
      writeFile: async () => { operations.push('writeFile'); },
      rename: async () => { operations.push('rename'); },
      unlink: async () => { operations.push('unlink'); },
    } as unknown as FsLike;
    await expect(ensureSecretsDirectory(fs, 'secrets')).rejects.toThrow('secrets-reparse-point');
    expect(operations).toEqual([]);
  });

  it('reports corrupt ciphertext as SecretUnreadableError and leaves other entries readable', async () => {
    const dir = await directory();
    const fs = (await import('node:fs/promises')) as unknown as FsLike;
    const host = createSecretsHost({ safeStorage: storage(), fs, dir });
    await host.set('good', 'still readable');
    await host.set('broken', 'will be corrupted');
    const brokenFile = `${createHash('sha256').update('broken').digest('hex')}.secret`;
    await writeFile(join(dir, brokenFile), Buffer.from('bad'));
    await expect(host.get('broken')).rejects.toBeInstanceOf(SecretUnreadableError);
    await expect(host.get('good')).resolves.toBe('still readable');
    await expect(host.get('missing')).resolves.toBeNull();
  });

  it('keeps the old value when atomic rename fails', async () => {
    const dir = await directory();
    const fs = (await import('node:fs/promises')) as unknown as FsLike;
    const host = createSecretsHost({ safeStorage: storage(), fs, dir });
    await host.set('token', 'old');
    const failingFs: FsLike = { ...fs, rename: async () => { throw new Error('rename failed'); } };
    const failing = createSecretsHost({ safeStorage: storage(), fs: failingFs, dir });
    await expect(failing.set('token', 'new')).rejects.toThrow('rename failed');
    await expect(host.get('token')).resolves.toBe('old');
  });

  it('atomically replaces an existing value on disk', async () => {
    const dir = await directory();
    const fs = (await import('node:fs/promises')) as unknown as FsLike;
    const host = createSecretsHost({ safeStorage: storage(), fs, dir });
    await host.set('token', 'old');
    await host.set('token', 'new');
    await expect(createSecretsHost({ safeStorage: storage(), fs, dir }).get('token')).resolves.toBe('new');
    await expect(readdir(dir)).resolves.toHaveLength(1);
  });

  it('rejects invalid keys and values over 64 KiB', async () => {
    const dir = await directory();
    const host = createSecretsHost({ safeStorage: storage(), fs: (await import('node:fs/promises')) as unknown as FsLike, dir });
    for (const key of ['', '..\\escape', 'x'.repeat(257), 'contains space']) await expect(host.get(key)).rejects.toThrow();
    await expect(host.set('valid', 'x'.repeat(65_537))).rejects.toThrow();
    await expect(host.set('valid', 'é'.repeat(32_769))).rejects.toThrow();
  });

  it('accepts a value of exactly 64 KiB', async () => {
    const dir = await directory();
    const host = createSecretsHost({ safeStorage: storage(), fs: (await import('node:fs/promises')) as unknown as FsLike, dir });
    const value = 'x'.repeat(64 * 1024);
    await host.set('maximum', value);
    await expect(host.get('maximum')).resolves.toBe(value);
  });
});
