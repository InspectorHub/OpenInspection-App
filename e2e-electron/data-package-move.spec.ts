import { expect, test } from '@playwright/test';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

/**
 * The guided move flow is a thin shell over the existing export/import panels.
 * This walkthrough verifies the shell in a real Electron window: both entry
 * buttons, step navigation, the derived "what did not move"/reconnect
 * checklist, the optional freeze step, and the return to Settings.
 *
 * The export/import panels' own step-up, progress and undo contracts are
 * covered by data-package-export.spec.ts and data-package-import.spec.ts; this
 * spec does not duplicate them.
 */
test.describe('data-package move wizard in the desktop window', () => {
  let desktop: DesktopHarness | undefined;
  test.beforeAll(prepareDesktopRenderer);
  test.afterAll(async () => { await desktop?.dispose(); });

  async function openMoveSection() {
    const { page } = desktop!;
    await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Move to another deployment' }) });
    await expect(section.getByRole('button', { name: 'Leave this workspace' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Arrive at this workspace' })).toBeVisible();
    return section;
  }

  test('arrive: walks the steps, shows the reconnect checklist, and returns on Back', async () => {
    test.setTimeout(180_000);
    desktop = await startDesktopHarness({ quitAnswer: 'quit' });
    const { page } = desktop;
    const section = await openMoveSection();

    await section.getByRole('button', { name: 'Arrive at this workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Move into this workspace' })).toBeVisible();

    // Step 1: choose, then verify, then restore (the embedded import panel), then reconnect.
    await expect(page.getByRole('heading', { name: 'Choose a package' })).toBeVisible();
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.getByRole('heading', { name: 'Check the package' })).toBeVisible();
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.getByRole('heading', { name: 'Restore', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose package file' })).toBeVisible();
    await page.getByRole('button', { name: 'Next step' }).click();

    // Final step: no import was run in this walkthrough, so the static reconnect
    // list shows with the "finish the step above" hint and no derived group.
    await expect(page.getByRole('heading', { name: 'Reconnect' })).toBeVisible();
    await expect(page.getByText(/Finish the step above to see the list/)).toBeVisible();
    await expect(page.getByText('Reconnect on the new deployment')).toBeVisible();
    await expect(page.getByText('Re-invite your team')).toBeVisible();
    await expect(page.getByText('What did not move')).toHaveCount(0);

    // BackLink leaves the wizard and restores Settings.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'Move to another deployment' })).toBeVisible();
  });

  test('leave: marks the freeze step optional and guards leaving the page', async () => {
    test.setTimeout(180_000);
    desktop = await startDesktopHarness({ quitAnswer: 'quit' });
    const { page } = desktop;
    const section = await openMoveSection();

    await section.getByRole('button', { name: 'Leave this workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Move away from this workspace' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Before you start' })).toBeVisible();

    // The step rail marks the freeze step as conditional (self-serve freeze is not available).
    await expect(page.getByText('3. Pause changes (if available)')).toBeVisible();

    // Finish on the last step opens a confirmation before leaving the page.
    for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.getByRole('heading', { name: 'Finish' })).toBeVisible();
    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('heading', { name: 'Leave this page?' })).toBeVisible();
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Move to another deployment' })).toBeVisible();
  });
});
