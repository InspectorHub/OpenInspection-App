import { expect, test } from '@playwright/test';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

/**
 * Real desktop-window walkthrough of the tenant data-package export entry
 * (A-4). The fake engine serves the E-1/E-2 data-package endpoints, so this
 * drives the actual IPC → main-process runner → progress-event path without a
 * second engine instance. It checks the flow reaches the completion view; the
 * package bytes themselves are covered by the runner's unit/integration tests.
 */
test.describe('data-package export from the desktop window', () => {
  let desktop: DesktopHarness | undefined;
  test.beforeAll(prepareDesktopRenderer);
  test.afterAll(async () => { await desktop?.dispose(); });

  test('step-up, watch progress and reach the completion view', async () => {
    test.setTimeout(120_000);
    desktop = await startDesktopHarness({ quitAnswer: 'quit' });
    const { page } = desktop;
    await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    const section = page.getByRole('region', { name: 'Complete data package' })
      .or(page.locator('section').filter({ has: page.getByRole('heading', { name: 'Complete data package' }) }));
    await expect(section.getByRole('button', { name: 'Start export' })).toBeVisible();
    await section.getByRole('button', { name: 'Start export' }).click();

    await section.getByLabel(/Re-enter your password/i).fill('current-password');
    await section.getByRole('button', { name: 'Confirm' }).click();

    // The fake engine returns a small package: progress then the completion view.
    await expect(section.getByText(/Export complete/i)).toBeVisible({ timeout: 30_000 });
    await expect(section.getByText(/Manifest SHA-256:/i)).toBeVisible();
    await expect(section.getByRole('button', { name: 'Done' })).toBeVisible();
  });
});
