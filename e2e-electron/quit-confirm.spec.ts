import { expect, test } from '@playwright/test';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

let desktop: DesktopHarness;
test.beforeAll(prepareDesktopRenderer);
test.beforeEach(async () => { desktop = await startDesktopHarness({ uploadDelayMs: 250, quitAnswer: 'stay' }); });
test.afterEach(async () => { await desktop?.dispose(); });

test('choosing Stay keeps the window open and lets active uploads continue', async () => {
  test.setTimeout(90_000);
  await desktop.openDiagnostics();
  await desktop.page.getByRole('button', { name: 'Start kill test' }).click();
  await expect.poll(() => desktop.engine.uploadCounts.size, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(desktop.engine.uploadCounts.size).toBeLessThan(20);
  const before = desktop.engine.uploadCounts.size;

  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close());
  await expect(desktop.page.getByRole('heading', { name: 'Diagnostics (development only)' })).toBeVisible();
  await expect.poll(() => desktop.engine.uploadCounts.size, { timeout: 20_000 }).toBeGreaterThan(before);
  await expect(desktop.page.getByTestId('check-kill-start')).toContainText('kill=finished', { timeout: 30_000 });
  expect(desktop.engine.uploads.size).toBe(20);
});
