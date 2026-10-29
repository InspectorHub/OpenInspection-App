import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { assertNotReparsePoint, type SecurityCommand } from './windows-security.ts';

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export interface FsLike {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer, options?: { mode?: number; flag?: string }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface SecretsHost {
  readonly available: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class SecretUnreadableError extends Error {
  constructor() { super('secret-unreadable'); this.name = 'SecretUnreadableError'; }
}

export class SecretsUnavailableError extends Error {
  constructor() { super('secrets-unavailable'); this.name = 'SecretsUnavailableError'; }
}

export async function ensureSecretsDirectory(
  fs: Pick<FsLike, 'mkdir' | 'lstat'>,
  dir: string,
  options: { windows?: boolean; run?: SecurityCommand } = {},
): Promise<void> {
  const check = async (stats: { isSymbolicLink(): boolean }): Promise<void> => {
    if (options.windows) {
      if (!options.run) throw new Error('secrets-reparse-check-failed');
      await assertNotReparsePoint({ path: dir, isSymbolicLink: stats.isSymbolicLink(), run: options.run });
    } else if (stats.isSymbolicLink()) {
      throw new Error('secrets-reparse-point');
    }
  };
  let existing: { isSymbolicLink(): boolean } | null = null;
  try { existing = await fs.lstat(dir); }
  catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (existing) {
    await check(existing);
    return;
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await check(await fs.lstat(dir));
}

const KEY = /^[\x21-\x7e]{1,256}$/;
const VALUE_BYTES_MAX = 64 * 1024;

function validateKey(key: string): void {
  if (!KEY.test(key) || /\.\.[\\/]/.test(key)) throw new TypeError('invalid-key');
}

function validateValue(value: string): void {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > VALUE_BYTES_MAX) throw new TypeError('invalid-value');
}

function entryPath(dir: string, key: string): string {
  const digest = createHash('sha256').update(key, 'utf8').digest('hex');
  return join(dir, `${digest}.secret`);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function atomicWrite(fs: FsLike, target: string, bytes: Buffer): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export function createSecretsHost(deps: { safeStorage: SafeStorageLike; fs: FsLike; dir: string }): SecretsHost {
  const available = deps.safeStorage.isEncryptionAvailable();
  return {
    available,
    async get(key) {
      if (!available) throw new SecretsUnavailableError();
      validateKey(key);
      let ciphertext: Buffer;
      try {
        ciphertext = await deps.fs.readFile(entryPath(deps.dir, key));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      try {
        return deps.safeStorage.decryptString(ciphertext);
      } catch {
        throw new SecretUnreadableError();
      }
    },
    async set(key, value) {
      validateKey(key);
      validateValue(value);
      if (!available) throw new SecretsUnavailableError();
      const ciphertext = deps.safeStorage.encryptString(value);
      await atomicWrite(deps.fs, entryPath(deps.dir, key), ciphertext);
    },
    async remove(key) {
      if (!available) throw new SecretsUnavailableError();
      validateKey(key);
      try {
        await deps.fs.unlink(entryPath(deps.dir, key));
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}
