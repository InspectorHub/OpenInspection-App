import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openNativeSqlite } from './db-open.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))); });

it('drops an uncommitted row after SIGKILL while preserving the committed positive control', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oi-db-crash-')); roots.push(dir);
  const file = join(dir, 'crash.db'); const key = 'ab'.repeat(32);
  const initial = openNativeSqlite(file); initial.pragma("cipher='sqlcipher'"); initial.pragma('legacy=4'); initial.key(Buffer.from(key, 'hex'));
  initial.pragma('journal_mode=WAL'); initial.pragma('synchronous=FULL'); initial.exec('CREATE TABLE crash_rows (value TEXT PRIMARY KEY)');
  initial.prepare('INSERT INTO crash_rows (value) VALUES (?)').run('committed'); initial.close();

  const childSource = [
    'const Database=require("better-sqlite3-multiple-ciphers");',
    'const db=new Database(process.argv[1]);',
    'db.pragma("cipher="+String.fromCharCode(39)+"sqlcipher"+String.fromCharCode(39));',
    'db.pragma("legacy=4"); db.key(Buffer.from(process.argv[2],"hex"));',
    'db.pragma("journal_mode=WAL"); db.pragma("synchronous=FULL");',
    'db.exec("BEGIN"); db.prepare("INSERT INTO crash_rows (value) VALUES (?)").run("uncommitted");',
    'process.kill(process.pid,"SIGKILL");',
  ].join(' ');
  const killed = spawnSync(process.execPath, ['-e', childSource, file, key], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  expect(killed.error).toBeUndefined();

  const reopened = openNativeSqlite(file); reopened.pragma("cipher='sqlcipher'"); reopened.pragma('legacy=4'); reopened.key(Buffer.from(key, 'hex'));
  const rows = reopened.prepare('SELECT value FROM crash_rows ORDER BY value').all() as Array<{ value: string }>;
  expect(rows).toEqual([{ value: 'committed' }]);
  reopened.close();
});
