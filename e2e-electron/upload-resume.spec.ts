import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareDesktopRenderer, startDesktopHarness, TASK16_SCREENSHOT_ROOT, type DesktopHarness } from './fixtures/desktop-harness';

let desktop: DesktopHarness;
test.beforeAll(prepareDesktopRenderer);
test.beforeEach(async () => { desktop = await startDesktopHarness({ uploadDelayMs: 120, quitAnswer: 'quit' }); });
test.afterEach(async () => { await desktop?.dispose(); });

test('force-stopping during a 50-photo upload resumes without duplicate keys or missing Content-Length', async () => {
  test.setTimeout(120_000);
  await desktop.page.context().setOffline(true);
  await desktop.openDiagnostics();
  await desktop.page.getByRole('button', { name: 'Start 50-photo restart test' }).click();
  await expect(desktop.page.getByTestId('check-desktop-kill-start')).toContainText('kill=running done=0 of=50', { timeout: 60_000 });
  expect(desktop.engine.uploadCounts.size).toBe(0);
  await desktop.page.context().setOffline(false);
  await expect.poll(async () => {
    const text = await desktop.page.getByTestId('check-desktop-kill-start').innerText();
    return Number(/done=(\d+)/.exec(text)?.[1] ?? 0);
  }, { timeout: 20_000 }).toBeGreaterThanOrEqual(10);
  await mkdir(TASK16_SCREENSHOT_ROOT, { recursive: true });
  await desktop.page.screenshot({ path: join(TASK16_SCREENSHOT_ROOT, 'upload-in-progress.png'), animations: 'disabled' });
  await desktop.page.context().setOffline(true);
  await expect.poll(() => desktop.engine.activeUploadCount, { timeout: 10_000 }).toBe(0);
  const receivedBeforeRestart = desktop.engine.uploadCounts.size;
  await desktop.page.waitForTimeout(300);
  expect(desktop.engine.uploadCounts.size).toBe(receivedBeforeRestart);
  expect(receivedBeforeRestart).toBeGreaterThanOrEqual(10);
  expect(receivedBeforeRestart).toBeLessThanOrEqual(40);

  await desktop.restartAfterForceKill();
  expect(await desktop.page.evaluate(() => navigator.onLine)).toBe(true);
  await desktop.openDiagnostics();
  await desktop.page.getByRole('button', { name: 'Resume 50-photo restart test' }).click();
  await expect(desktop.page.getByTestId('check-desktop-kill-resume')).toContainText('pending=0 uploading=0', { timeout: 45_000 });

  expect(desktop.engine.uploads.size, `received_before_restart=${String(receivedBeforeRestart)} upload_requests=${String(desktop.engine.uploadCounts.size)} resume=${await desktop.page.getByTestId('check-desktop-kill-resume').innerText()}`).toBe(50);
  const duplicateKeys = [...desktop.engine.uploadCounts.entries()].filter(([, count]) => count !== 1);
  expect([...desktop.engine.uploadCounts.values()], `duplicate keys: ${duplicateKeys.map(([key]) => key.split('/').at(-1)).join(',')}`).toEqual(Array.from({ length: 50 }, () => 1));
  expect(desktop.engine.uploadContentLengths).toHaveLength(50);
  expect(desktop.engine.uploadContentLengths.every((length) => length !== null && length > 0)).toBe(true);
});
