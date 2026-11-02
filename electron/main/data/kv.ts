import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { FsLike } from './secrets.ts';

const KEY = /^[\x21-\x7e]{1,256}$/;
const VALUE_BYTES_MAX = 64 * 1024;

function validate(key: string, value?: string): void {
  if (!KEY.test(key) || /\.\.[\\/]/.test(key)) throw new TypeError('invalid-key');
  if (value !== undefined && Buffer.byteLength(value, 'utf8') > VALUE_BYTES_MAX) throw new TypeError('invalid-value');
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function createKvHost(deps: { fs: FsLike; file: string }): {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
} {
  let pending = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };

  async function read(): Promise<Record<string, string>> {
    let bytes: Buffer;
    try { bytes = await deps.fs.readFile(deps.file); }
    catch (error) { if (isMissing(error)) return Object.create(null) as Record<string, string>; throw error; }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('kv-unreadable');
    const values: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(parsed)) {
      if (!KEY.test(key) || typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > VALUE_BYTES_MAX) throw new Error('kv-unreadable');
      values[key] = value;
    }
    return values;
  }

  return {
    async get(key) {
      validate(key);
      return serialized(async () => (await read())[key] ?? null);
    },
    async set(key, value) {
      validate(key, value);
      return serialized(async () => {
        const values = await read();
        values[key] = value;
        await deps.fs.mkdir(dirname(deps.file), { recursive: true, mode: 0o700 });
        const temporary = `${deps.file}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await deps.fs.writeFile(temporary, Buffer.from(JSON.stringify(values), 'utf8'), { mode: 0o600, flag: 'wx' });
          await deps.fs.rename(temporary, deps.file);
        } catch (error) {
          await deps.fs.unlink(temporary).catch(() => {});
          throw error;
        }
      });
    },
  };
}
