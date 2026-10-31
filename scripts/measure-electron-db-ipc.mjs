import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from '@playwright/test';

const userData = await mkdtemp(join(tmpdir(), 'oi-db-ipc-measure-'));
let app;
try {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.OI_USER_DATA_DIR = userData;
  env.OI_RENDERER_ROOT = resolve('e2e-electron/fixtures/shell-page');
  app = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env, timeout: 30_000 });
  const page = await app.firstWindow();
  await page.locator('#status').waitFor({ state: 'visible' });
  await page.locator('#status').evaluate((element) => {
    if (element.textContent !== 'Shell checks complete') throw new Error('Electron test renderer did not finish startup');
  });
  const opened = await page.evaluate(async () => window.oiDesktop?.db.open());
  assert.equal(opened?.ok, true, `Desktop database open failed: ${JSON.stringify(opened)}`);
  await page.evaluate(async () => {
    const db = window.oiDesktop.db;
    await db.execute('CREATE TABLE IF NOT EXISTS ipc_perf (value INTEGER NOT NULL)');
    await db.execute('DELETE FROM ipc_perf');
  });
  await app.evaluate(async () => {
    const { monitorEventLoopDelay } = process.getBuiltinModule('node:perf_hooks');
    const monitor = monitorEventLoopDelay({ resolution: 1 });
    monitor.enable();
    await new Promise((resolve) => setTimeout(resolve, 25));
    globalThis.__task6DbLoopMonitor = monitor;
  });
  const measurement = await page.evaluate(async () => {
    const db = window.oiDesktop.db;
    const start = performance.now();
    await db.begin();
    for (let value = 0; value < 2_000; value += 1) await db.run('INSERT INTO ipc_perf (value) VALUES (?)', [value]);
    await db.commit();
    const elapsedMs = performance.now() - start;
    const count = await db.query('SELECT count(*) AS count FROM ipc_perf');
    return { elapsedMs, count: count[0]?.count };
  });
  const eventLoopMaxDelayMs = await app.evaluate(() => {
    const monitor = globalThis.__task6DbLoopMonitor;
    const maximum = monitor.max / 1e6;
    monitor.disable();
    return maximum;
  });
  assert.equal(measurement.count, 2_000);
  console.log(JSON.stringify({ runs: 2_000, transactionElapsedMs: Number(measurement.elapsedMs.toFixed(2)), mainEventLoopMaxDelayMs: Number(eventLoopMaxDelayMs.toFixed(2)) }));
  await page.evaluate(async () => window.oiDesktop.db.close());
  const dbDir = join(userData, 'db');
  const secretPath = join(userData, 'secrets', `${createHash('sha256').update('db-key').digest('hex')}.secret`);
  const oldDatabaseBytes = await readFile(join(dbDir, 'inspectorhub.db'));
  const oldKey = await page.evaluate(async () => window.oiDesktop.secrets.get('db-key'));
  const corruptSecret = Buffer.from('corrupt existing safeStorage entry');
  await writeFile(secretPath, corruptSecret);
  assert.deepEqual(await page.evaluate(async () => window.oiDesktop.db.open()), { ok: false, reason: 'key-unreadable' });
  await page.evaluate(async () => window.oiDesktop.db.setAsideUnreadable());
  const moved = (await readdir(userData)).filter((name) => name.startsWith('unreadable-'));
  assert.equal(moved.length, 1);
  assert.deepEqual(await readFile(join(userData, moved[0], 'inspectorhub.db')), oldDatabaseBytes);
  assert.notDeepEqual(await readFile(secretPath), corruptSecret);
  const rotatedKey = await page.evaluate(async () => window.oiDesktop.secrets.get('db-key'));
  assert.match(rotatedKey, /^[0-9a-f]{64}$/);
  assert.notEqual(rotatedKey, oldKey);
  assert.deepEqual(await page.evaluate(async () => window.oiDesktop.db.open()).then(({ ok, reason }) => ({ ok, reason })), { ok: true, reason: undefined });
  const closed = app.waitForEvent('close', { timeout: 5_000 });
  await page.evaluate(() => window.close()).catch(() => undefined);
  await closed;
  app = null;
} finally {
  if (app) await app.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
