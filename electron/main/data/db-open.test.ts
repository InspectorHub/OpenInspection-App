import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from '../../../src/platform/schema.ts';
import { openDesktopDb, openNativeSqlite, setAsideUnreadableDatabase, type DbFsLike } from './db-open.ts';
import { createSecretsHost, SecretUnreadableError, type SecretsHost } from './secrets.ts';

const roots: string[] = [];
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'oi-desktop-db-')); roots.push(value); return value; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });

function secrets(values = new Map<string, string>(), onSet?: () => void): SecretsHost {
  return { available: true, get: async (key) => values.get(key) ?? null, set: async (key, value) => { onSet?.(); values.set(key, value); }, remove: async (key) => { values.delete(key); } };
}

async function seed(file: string, key: string, version: number, shape: 'current-v1' | 'drift' = 'current-v1'): Promise<void> {
  const db = openNativeSqlite(file);
  db.pragma("cipher='sqlcipher'"); db.pragma('legacy=4'); db.key(Buffer.from(key, 'hex'));
  if (shape === 'current-v1') for (const migration of MIGRATIONS.filter((entry) => entry.toVersion <= 1)) for (const sql of migration.statements) db.exec(sql);
  else db.exec('CREATE TABLE outbox (idempotency_key TEXT PRIMARY KEY)');
  db.pragma(`user_version=${String(version)}`); db.close();
}

describe('openDesktopDb with real SQLCipher', () => {
  it('stores the 32-byte key before creating a new database and reopens with the same key', async () => {
    const dir = await root();
    const file = join(dir, 'inspectorhub.db');
    const values = new Map<string, string>();
    const host = await openDesktopDb({ dbDir: dir, secrets: secrets(values, () => expect(existsSync(file)).toBe(false)), open: openNativeSqlite, now: () => 1_798_000_000_000, log: vi.fn() });
    expect(host.outcome).toEqual({ ok: true, schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(values.get('db-key')).toMatch(/^[0-9a-f]{64}$/);
    host.host?.close();
    const reopened = await openDesktopDb({ dbDir: dir, secrets: secrets(values), open: openNativeSqlite, now: () => 1_798_000_000_000, log: vi.fn() });
    expect(reopened.outcome).toEqual({ ok: true, schemaVersion: CURRENT_SCHEMA_VERSION });
    reopened.host?.close();
  });

  it('does not touch an existing database or create files when its key cannot be read', async () => {
    const dir = await root(); const file = join(dir, 'inspectorhub.db'); const key = '11'.repeat(32);
    await seed(file, key, CURRENT_SCHEMA_VERSION);
    const before = await readFile(file); const beforeStat = await stat(file); const log = vi.fn();
    const result = await openDesktopDb({ dbDir: dir, secrets: { ...secrets(), get: async () => { throw new SecretUnreadableError(); } }, open: openNativeSqlite, now: () => 1_798_000_000_000, log });
    expect(result).toEqual({ outcome: { ok: false, reason: 'key-unreadable' }, host: null });
    expect(await readFile(file)).toEqual(before); expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readdir(dir)).toEqual(['inspectorhub.db']); expect(log).not.toHaveBeenCalled();
  });

  it('sets unreadable data aside, rotates the still-present secret, then opens a fresh database', async () => {
    const dir = await root();
    const dbDir = join(dir, 'db'); const secretsDir = join(dir, 'secrets');
    await mkdir(dbDir); await mkdir(secretsDir);
    const file = join(dbDir, 'inspectorhub.db'); const oldKey = '81'.repeat(32);
    await seed(file, oldKey, CURRENT_SCHEMA_VERSION);
    const oldDatabase = openNativeSqlite(file); oldDatabase.pragma("cipher='sqlcipher'"); oldDatabase.pragma('legacy=4'); oldDatabase.key(Buffer.from(oldKey, 'hex'));
    oldDatabase.exec('CREATE TABLE preserved_marker (value TEXT NOT NULL)'); oldDatabase.close();
    const entry = join(secretsDir, `${createHash('sha256').update('db-key').digest('hex')}.secret`);
    await writeFile(entry, Buffer.from('unreadable encrypted payload'));
    const secretStore = createSecretsHost({ safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: () => { throw new Error('cannot decrypt'); },
    }, fs: await import('node:fs/promises'), dir: secretsDir });
    const blocked = await openDesktopDb({ dbDir, secrets: secretStore, open: openNativeSqlite, now: () => Date.UTC(2026, 9, 29, 10, 11, 12), log: vi.fn() });
    expect(blocked.outcome).toEqual({ ok: false, reason: 'key-unreadable' });
    const originalBytes = await readFile(file);
    const events: string[] = [];
    const nodeFs = await import('node:fs/promises');
    const orderedFs = { ...nodeFs, rename: async (from: string, to: string) => { events.push('rename-db'); await nodeFs.rename(from, to); } };
    const rotatingStore: SecretsHost = { ...secretStore, set: async (key, value) => { events.push('write-key'); await secretStore.set(key, value); } };
    const archive = await setAsideUnreadableDatabase({ dbDir, secrets: rotatingStore, fs: orderedFs, now: () => Date.UTC(2026, 9, 29, 10, 11, 12) });
    if (archive === null) throw new Error('database archive was not created');
    expect(events).toEqual(['rename-db', 'write-key']);
    expect(archive).toContain('unreadable-2026-10-29T10-11-12-000Z');
    expect(await readFile(join(archive, 'inspectorhub.db'))).toEqual(originalBytes);
    const readableStore = createSecretsHost({ safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`),
      decryptString: (bytes) => Buffer.from(bytes).toString().slice('encrypted:'.length),
    }, fs: await import('node:fs/promises'), dir: secretsDir });
    const reopenedKey = await readableStore.get('db-key');
    expect(reopenedKey).toMatch(/^[0-9a-f]{64}$/);
    expect(reopenedKey).not.toBe(oldKey);
    const fresh = await openDesktopDb({ dbDir, secrets: readableStore, open: openNativeSqlite, now: () => Date.UTC(2026, 9, 29, 10, 11, 12), log: vi.fn() });
    expect(fresh.outcome).toEqual({ ok: true, schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(fresh.host?.query("SELECT name FROM sqlite_master WHERE type='table' AND name='preserved_marker'", [])).toEqual([]);
    fresh.host?.close();
    expect(await readdir(dbDir)).toEqual(['inspectorhub.db']);
    expect(await readFile(entry)).not.toEqual(Buffer.from('unreadable encrypted payload'));
  });

  it('keeps the corrupt key and database in place when the directory rename fails', async () => {
    const dir = await root(); const dbDir = join(dir, 'db'); const secretsDir = join(dir, 'secrets');
    await mkdir(dbDir); await mkdir(secretsDir);
    const file = join(dbDir, 'inspectorhub.db'); await writeFile(file, Buffer.from('old db bytes'));
    const entry = join(secretsDir, `${createHash('sha256').update('db-key').digest('hex')}.secret`);
    const corruptBytes = Buffer.from('still unreadable'); await writeFile(entry, corruptBytes);
    const fs = { ...(await import('node:fs/promises')), rename: async () => { throw new Error('injected rename failure'); } };
    const secretsHost = createSecretsHost({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: () => { throw new Error('corrupt'); } }, fs: await import('node:fs/promises'), dir: secretsDir });
    await expect(setAsideUnreadableDatabase({ dbDir, secrets: secretsHost, fs, now: () => Date.UTC(2026, 9, 29) })).rejects.toThrow('injected rename failure');
    expect(await readFile(file)).toEqual(Buffer.from('old db bytes'));
    expect(await readFile(entry)).toEqual(corruptBytes);
  });

  it('leaves the moved database available and retries key rotation when writing the new secret fails', async () => {
    const dir = await root(); const dbDir = join(dir, 'db'); const secretsDir = join(dir, 'secrets');
    await mkdir(dbDir); await mkdir(secretsDir);
    const file = join(dbDir, 'inspectorhub.db'); await writeFile(file, Buffer.from('old db bytes'));
    const entry = join(secretsDir, `${createHash('sha256').update('db-key').digest('hex')}.secret`);
    await writeFile(entry, Buffer.from('still unreadable'));
    const baseStore = createSecretsHost({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: () => { throw new Error('corrupt'); } }, fs: await import('node:fs/promises'), dir: secretsDir });
    const failWrite: SecretsHost = { ...baseStore, set: async () => { throw new Error('injected secret write failure'); } };
    const now = () => Date.UTC(2026, 9, 29, 10, 11, 12);
    await expect(setAsideUnreadableDatabase({ dbDir, secrets: failWrite, fs: await import('node:fs/promises'), now })).rejects.toThrow('injected secret write failure');
    const archive = join(dir, 'unreadable-2026-10-29T10-11-12-000Z');
    expect(await readFile(join(archive, 'inspectorhub.db'))).toEqual(Buffer.from('old db bytes'));
    await setAsideUnreadableDatabase({ dbDir, secrets: baseStore, fs: await import('node:fs/promises'), now });
    const readableStore = createSecretsHost({ safeStorage: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (bytes) => Buffer.from(bytes).toString().slice('encrypted:'.length) }, fs: await import('node:fs/promises'), dir: secretsDir });
    const newKey = await readableStore.get('db-key');
    expect(newKey).toMatch(/^[0-9a-f]{64}$/);
    const fresh = await openDesktopDb({ dbDir, secrets: readableStore, open: openNativeSqlite, now, log: vi.fn() });
    expect(fresh.outcome.ok).toBe(true);
    expect(await readFile(join(archive, 'inspectorhub.db'))).toEqual(Buffer.from('old db bytes'));
    fresh.host?.close();
  });

  it('fails closed when encryption is unavailable', async () => {
    const dir = await root(); const open = vi.fn(openNativeSqlite);
    const result = await openDesktopDb({ dbDir: dir, secrets: { ...secrets(), available: false }, open, now: () => 1, log: vi.fn() });
    expect(result).toEqual({ outcome: { ok: false, reason: 'encryption-unavailable' }, host: null });
    expect(open).not.toHaveBeenCalled(); expect(await readdir(dir)).toEqual([]);
  });

  it('leaves a future-schema database byte-for-byte untouched and does not back it up', async () => {
    const dir = await root(); const file = join(dir, 'inspectorhub.db'); const key = '22'.repeat(32);
    await seed(file, key, CURRENT_SCHEMA_VERSION + 5);
    const before = await readFile(file); const beforeStat = await stat(file);
    const result = await openDesktopDb({ dbDir: dir, secrets: secrets(new Map([['db-key', key]])), open: openNativeSqlite, now: () => 1, log: vi.fn() });
    expect(result).toEqual({ outcome: { ok: false, reason: 'schema-too-new' }, host: null });
    expect(await readFile(file)).toEqual(before); expect((await stat(file)).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(await readdir(dir)).toEqual(['inspectorhub.db']);
  });

  it('checkpoints WAL and copies a v1 backup before the first migration statement, retaining only two backups', async () => {
    const dir = await root(); const file = join(dir, 'inspectorhub.db'); const key = '33'.repeat(32); const events: string[] = [];
    await seed(file, key, 1);
    const backupsDir = join(dir, 'backups'); await mkdir(backupsDir);
    for (const [name, year] of [['2020', 2020], ['2021', 2021], ['2022', 2022]] as const) {
      const path = join(backupsDir, `inspectorhub-v1-${name}-01-01T00-00-00-000Z.db`);
      await writeFile(path, `old backup ${name}`); await utimes(path, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year, 0, 1)));
    }
    const fs = { ...(await import('node:fs/promises')), copyFile: async (source: string, destination: string) => { events.push('copy'); await (await import('node:fs/promises')).copyFile(source, destination); } } as unknown as DbFsLike;
    const opened = await openDesktopDb({ dbDir: dir, secrets: secrets(new Map([['db-key', key]])), fs,
      open: (path) => {
        const db = openNativeSqlite(path);
        return { ...db, exec: (sql: string) => { if (sql.startsWith('CREATE TABLE IF NOT EXISTS item_tags')) events.push('first-migration'); db.exec(sql); }, pragma: (sql: string, options?: { simple?: boolean }) => { if (sql.startsWith('wal_checkpoint')) events.push('checkpoint'); return db.pragma(sql, options); }, get inTransaction() { return db.inTransaction; } };
      }, now: () => Date.UTC(2026, 9, 29, 10), log: vi.fn() });
    expect(opened.outcome).toEqual({ ok: true, schemaVersion: CURRENT_SCHEMA_VERSION });
    expect(events).toEqual(['checkpoint', 'copy', 'first-migration']);
    const backups = await readdir(backupsDir);
    expect(backups.sort()).toEqual(['inspectorhub-v1-2022-01-01T00-00-00-000Z.db', 'inspectorhub-v1-2026-10-29T10-00-00-000Z.db']);
    opened.host?.close();
  });

  it('returns io and leaves user_version at the previous committed version when migration fails', async () => {
    const dir = await root(); const file = join(dir, 'inspectorhub.db'); const key = '44'.repeat(32); await seed(file, key, 1);
    const result = await openDesktopDb({ dbDir: dir, secrets: secrets(new Map([['db-key', key]])), open: (path) => {
      const db = openNativeSqlite(path);
      return { ...db, exec: (sql: string) => { if (sql.startsWith('CREATE TABLE IF NOT EXISTS item_tags')) throw new Error('injected migration failure'); db.exec(sql); }, get inTransaction() { return db.inTransaction; } };
    }, now: () => 1_798_000_000_000, log: vi.fn() });
    expect(result).toEqual({ outcome: { ok: false, reason: 'io' }, host: null });
    const check = openNativeSqlite(file); check.pragma("cipher='sqlcipher'"); check.pragma('legacy=4'); check.key(Buffer.from(key, 'hex'));
    expect(check.pragma('user_version', { simple: true })).toBe(1); check.close();
  });

  it('reports an old draft schema as drift', async () => {
    const dir = await root(); const key = '55'.repeat(32); await seed(join(dir, 'inspectorhub.db'), key, 1, 'drift');
    const result = await openDesktopDb({ dbDir: dir, secrets: secrets(new Map([['db-key', key]])), open: openNativeSqlite, now: () => 1, log: vi.fn() });
    expect(result).toEqual({ outcome: { ok: false, reason: 'schema-drift' }, host: null });
  });

  it('rejects a wrong key and a file without a SQLite header, and uses FULL synchronous mode', async () => {
    const dir = await root(); const key = '66'.repeat(32); const file = join(dir, 'inspectorhub.db'); await seed(file, key, CURRENT_SCHEMA_VERSION);
    const wrong = await openDesktopDb({ dbDir: dir, secrets: secrets(new Map([['db-key', '77'.repeat(32)]])), open: openNativeSqlite, now: () => 1, log: vi.fn() });
    expect(wrong.outcome).toEqual({ ok: false, reason: 'corrupt' });
    const badKey = openNativeSqlite(file); badKey.pragma("cipher='sqlcipher'"); badKey.pragma('legacy=4'); badKey.key(Buffer.from('77'.repeat(32), 'hex'));
    expect(() => badKey.pragma('user_version', { simple: true })).toThrow(); badKey.close();
    const wrongHeaderDir = join(dir, 'invalid'); await (await import('node:fs/promises')).mkdir(wrongHeaderDir); await writeFile(join(wrongHeaderDir, 'inspectorhub.db'), Buffer.from('definitely not SQLite data'));
    const invalid = await openDesktopDb({ dbDir: wrongHeaderDir, secrets: secrets(new Map([['db-key', key]])), open: openNativeSqlite, now: () => 1, log: vi.fn() });
    expect(invalid.outcome).toEqual({ ok: false, reason: 'corrupt' });
    const openedConnections: Array<ReturnType<typeof openNativeSqlite>> = [];
    const valid = await openDesktopDb({ dbDir: dir, secrets: secrets(new Map([['db-key', key]])), open: (path) => { const db = openNativeSqlite(path); openedConnections.push(db); return db; }, now: () => 1, log: vi.fn() });
    expect(valid.host).not.toBeNull();
    expect(openedConnections[0]?.pragma('synchronous', { simple: true })).toBe(2); valid.host?.close();
  });
});
