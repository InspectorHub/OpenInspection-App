import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareDesktopRenderer, startDesktopHarness, TASK16_SCREENSHOT_ROOT, type DesktopHarness } from './fixtures/desktop-harness';

let desktop: DesktopHarness;
test.beforeAll(prepareDesktopRenderer);
test.beforeEach(async () => { desktop = await startDesktopHarness(); });
test.afterEach(async () => { await desktop?.dispose(); });

test('the real lock-clock check passes in the running desktop window', async () => {
  await desktop.openDiagnostics();
  await desktop.page.getByRole('button', { name: 'Run lock-clock' }).click();
  await expect(desktop.page.getByTestId('summary')).toContainText('lock-clock PASS', { timeout: 15_000 });
  await expect(desktop.page.getByTestId('summary')).toContainText('read_only_result=unlocked');

  await desktop.page.getByRole('button', { name: 'Close diagnostics' }).click();
  const old = String(Date.now() - 31 * 86_400_000);
  await desktop.page.evaluate((oldValue) => window.oiDesktop.db.run("UPDATE device_state SET value = ? WHERE key IN ('last_verified_at', 'max_seen_time')", [oldValue]), old);
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:active-change', true));
  await expect(desktop.page.getByRole('heading', { name: 'Verification needed' })).toBeVisible({ timeout: 10_000 });
  await mkdir(TASK16_SCREENSHOT_ROOT, { recursive: true });
  await desktop.page.screenshot({ path: join(TASK16_SCREENSHOT_ROOT, 'verification-needed.png'), animations: 'disabled' });
});
