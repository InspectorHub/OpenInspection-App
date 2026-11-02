import { expect, test } from '@playwright/test';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

declare global { interface Window { dbCrashStarted?: boolean; } }

let desktop: DesktopHarness;
test.beforeAll(prepareDesktopRenderer);
test.beforeEach(async () => { desktop = await startDesktopHarness(); });
test.afterEach(async () => { await desktop?.dispose(); });

test('a gracefully restarted signed-in desktop reopens its existing encrypted profile', async () => {
  await desktop.restartGracefully();
  await expect(desktop.page.getByRole('heading', { name: 'Work list' })).toBeVisible();
});

test('a hard-stopped signed-in desktop reopens its existing encrypted profile', async () => {
  await desktop.restartAfterForceKill();
  await expect(desktop.page.getByRole('heading', { name: 'Work list' })).toBeVisible();
});

test('a killed SQLite transaction rolls back on restart, and the real db-tx and yjs-persist checks pass', async () => {
  test.setTimeout(90_000);
  const doc = 'e2e-mid-transaction';
  await expect.poll(
    () => desktop.page.evaluate(() => window.oiDesktop.db.query('SELECT 1 AS ready')),
    { timeout: 15_000 },
  ).toEqual([{ ready: 1 }]);
  await desktop.page.evaluate(async (docName) => {
    await window.oiDesktop.db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [docName]);
    await window.oiDesktop.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [docName, new Uint8Array([1])]);
    await window.oiDesktop.db.begin();
    await window.oiDesktop.db.run('INSERT INTO ydoc_updates (doc_name, data) VALUES (?, ?)', [docName, new Uint8Array([2])]);
    window.dbCrashStarted = true;
  }, doc);
  await expect.poll(() => desktop.page.evaluate(() => window.dbCrashStarted)).toBe(true);

  await desktop.restartAfterForceKill();
  const rows = await desktop.page.evaluate((docName) => window.oiDesktop.db.query<{ data: Uint8Array }>('SELECT data FROM ydoc_updates WHERE doc_name = ? ORDER BY id', [docName]), doc);
  expect(rows.map((row) => row.data[0])).toEqual([1]);
  await desktop.page.evaluate(async (docName) => window.oiDesktop.db.run('DELETE FROM ydoc_updates WHERE doc_name = ?', [docName]), doc);

  await desktop.openDiagnostics();
  await desktop.page.getByRole('button', { name: 'Run db-tx' }).click();
  await expect(desktop.page.getByTestId('summary')).toContainText('db-tx PASS', { timeout: 20_000 });
  await desktop.page.getByRole('button', { name: 'Run yjs-persist' }).click();
  await expect(desktop.page.getByTestId('summary')).toContainText('yjs-persist PASS', { timeout: 20_000 });
});
