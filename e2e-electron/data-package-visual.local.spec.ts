import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

/**
 * LOCAL-ONLY visual walkthrough (not run in CI via the `ci` project). Drives the
 * real Electron window through every interactive export state and saves a
 * screenshot of each to a temp dir for human review with ViewImage. The path is
 * printed at the end. Slow + bad-media engine flags make transient states
 * capturable.
 */
const OUT = join(tmpdir(), 'dp-ui-states');

test.describe('data-package UI states (local visual review)', () => {
  let desktop: DesktopHarness | undefined;
  test.beforeAll(async () => {
    mkdirSync(OUT, { recursive: true });
    process.env.OI_DP_DELAY_MS = '1200';
    process.env.OI_DP_BAD_MEDIA = '1';
    await prepareDesktopRenderer();
  });
  test.afterAll(async () => {
    await desktop?.dispose();
    delete process.env.OI_DP_DELAY_MS;
    delete process.env.OI_DP_BAD_MEDIA;
  });

  test('capture step-up, running, paused and completion states', async () => {
    test.setTimeout(150_000);
    desktop = await startDesktopHarness({ quitAnswer: 'quit' });
    const { page } = desktop;
    await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Complete data package' }) });
    await expect(section.getByRole('button', { name: 'Start export' })).toBeVisible();

    // 1) idle section
    await section.screenshot({ path: join(OUT, '1-idle.png') });

    // 2) step-up prompt
    await section.getByRole('button', { name: 'Start export' }).click();
    await expect(section.getByLabel(/Re-enter your password/i)).toBeVisible();
    await section.screenshot({ path: join(OUT, '2-step-up.png') });

    // 3) running + estimate
    await section.getByLabel(/Re-enter your password/i).fill('pw');
    await section.getByRole('button', { name: 'Confirm' }).click();
    await expect(section.getByText(/Estimated:/)).toBeVisible({ timeout: 15_000 });
    await section.screenshot({ path: join(OUT, '3-running-estimate.png') });

    // 4) paused
    await expect(section.getByRole('button', { name: 'Pause export' })).toBeVisible();
    await section.getByRole('button', { name: 'Pause export' }).click();
    await expect(section.getByText(/Paused/i)).toBeVisible({ timeout: 15_000 });
    await section.screenshot({ path: join(OUT, '4-paused.png') });

    // resume → completion with excluded item
    await section.getByRole('button', { name: 'Resume export' }).click();
    await expect(section.getByText(/Export complete/i)).toBeVisible({ timeout: 60_000 });
    await section.screenshot({ path: join(OUT, '5-complete-excluded.png') });

    // 6) acknowledged
    const ack = section.getByRole('checkbox', { name: /understand/i });
    if (await ack.count()) {
      await ack.check();
      await section.screenshot({ path: join(OUT, '6-acknowledged.png') });
    }
    console.log(`SCREENSHOTS SAVED TO ${OUT}`);
  });
});
