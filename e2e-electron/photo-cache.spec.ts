import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openSeededEditor, prepareDesktopRenderer, seedEditorPackage, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

let desktop: DesktopHarness;
test.beforeAll(prepareDesktopRenderer);
test.afterEach(async () => { await desktop?.dispose(); });

/** The editor's photo thumbnail: an <img> whose address is a copy under photo-cache/. */
function cachedThumbnail(page: Page): Locator {
  return page.locator('img[src^="oi-media://media/photo-cache/"]').first();
}

async function addPhoto(page: Page): Promise<void> {
  await page.locator('input[type=file][multiple]').evaluate((element) => element.removeAttribute('accept'));
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add from library' }).click();
  await (await picker).setFiles({ name: 'roof.jpg', mimeType: 'image/jpeg', buffer: await readFile(resolve('e2e-electron/fixtures/photo-import.jpg')) });
}

/** The picture really decoded: not the 1x1 of a failed load, and not the grey placeholder (a data: address). */
async function expectRealPicture(image: Locator): Promise<void> {
  await expect.poll(() => image.evaluate((element) => {
    const img = element as HTMLImageElement;
    return img.complete && img.naturalWidth > 1 && img.naturalHeight > 1 && !img.src.startsWith('data:');
  }), { timeout: 20_000 }).toBe(true);
}

test('an uploaded photo keeps a real thumbnail, and a server-only photo is fetched with the session and survives an offline restart', async () => {
  test.setTimeout(180_000);
  desktop = await startDesktopHarness({ quitAnswer: 'quit' });
  const { page, engine } = desktop;
  await seedEditorPackage(page);
  await addPhoto(page);
  await expect.poll(() => engine.uploads.size, { timeout: 30_000 }).toBe(1);
  await expect(page.getByText('1 photo', { exact: true })).toBeVisible({ timeout: 20_000 });

  // Right after the upload the thumbnail is a picture, not the grey placeholder.
  await expectRealPicture(cachedThumbnail(page));
  await expect(page.locator('img[src^="data:image/svg+xml"]')).toHaveCount(0);

  // The device has nothing of this photo but the server's copy: no file in media, no cached copy.
  await page.evaluate(async () => {
    const rows = await window.oiDesktop.db.query<{ path: string }>('SELECT path FROM media');
    for (const row of rows) await window.oiDesktop.files.remove(row.path);
    await window.oiDesktop.db.run('DELETE FROM media');
    const cached = await window.oiDesktop.db.query<{ path: string }>('SELECT path FROM photo_cache');
    for (const row of cached) await window.oiDesktop.files.remove(row.path);
    await window.oiDesktop.db.run('DELETE FROM photo_cache');
  });
  await desktop.restartGracefully();
  await openSeededEditor(desktop.page);
  await expectRealPicture(cachedThumbnail(desktop.page));
  const asked = engine.photoRequests;
  expect(asked.length).toBeGreaterThanOrEqual(1);
  expect(asked.every((r) => r.authorized)).toBe(true);
  expect(asked[0]?.w).toBe('480');
  expect(asked.every((r) => r.key.startsWith('renderer-tenant/inspections/insp-7/photos/'))).toBe(true);

  // Offline from now on: the copy is on the device, so the thumbnail still shows after a restart.
  const requestsBefore = engine.photoRequests.length;
  engine.setUnavailable(true);
  await desktop.restartGracefully();
  await openSeededEditor(desktop.page);
  await expectRealPicture(cachedThumbnail(desktop.page));
  expect(engine.photoRequests.length).toBe(requestsBefore);
});
