import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '../electron/shared/ipc-contract.ts';
import { startRendererEngine, type RendererEngine } from './fixtures/renderer-engine.ts';

declare global { interface Window { oiDesktop: DesktopBridge } }

let electronApp: ElectronApplication;
let page: Page;
let engine: RendererEngine;
let userData: string;
let environment: Record<string, string>;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-heic-editor-'));
  engine = await startRendererEngine();
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OI_USER_DATA_DIR = userData;
  environment.OI_RENDERER_ROOT = resolve('dist-electron/renderer');
  environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  environment.OI_E2E_HEIC_HELPER = resolve('.superpowers/sdd/plan-d2-windows-electron/helper-codec-missing.exe');
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(({ shell }) => { shell.openExternal = async (url) => { Reflect.set(globalThis, 'rendererExternalUrl', url); }; });
});

test.afterEach(async () => {
  await electronApp?.close();
  await engine?.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function signIn(): Promise<void> {
  await page.getByLabel('Server address').fill(engine.url);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => electronApp.evaluate(() => Reflect.get(globalThis, 'rendererExternalUrl'))).toEqual(expect.stringContaining('/oauth/authorize?'));
  const authorizeUrl = String(await electronApp.evaluate(() => Reflect.get(globalThis, 'rendererExternalUrl')));
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (!state) throw new Error('renderer-auth-state-missing');
  const callback = new URL('io.inspectorhub.app:/oauth/callback');
  callback.searchParams.set('code', 'renderer-code');
  callback.searchParams.set('state', state);
  const executable = await electronApp.evaluate(() => process.execPath);
  const child = spawn(
    executable,
    ['dist-electron/main/index.cjs', callback.href],
    { cwd: process.cwd(), env: environment, windowsHide: true, stdio: 'ignore' },
  );
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  expect(exit).toBe(0);
  await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 20_000 });
}

async function seedEditorPackage(): Promise<void> {
  await page.evaluate(async () => {
    const db = window.oiDesktop.db;
    const accountKey = 'renderer-tenant:renderer-user';
    const inspectionId = 'insp-7';
    const snapshot = { schemaVersion: 2, sections: [{ id: 'sec_roof', title: 'Roof', items: [{ id: 'itm_cover', label: 'Roof cover', type: 'rich' }] }] };
    const entries: Array<[string, unknown, string]> = [
      [`/api/inspections/${inspectionId}`, { inspection: { id: inspectionId, status: 'scheduled', date: '2026-11-01T10:00:00Z', inspectorId: 'renderer-user', propertyType: 'single_family', propertyAddress: '77 Test Photo Lane', reportStatus: 'in_progress', templateSnapshot: snapshot }, v: 1 }, inspectionId],
      [`/api/inspections/${inspectionId}/results`, { results: {}, resultId: 'result-1' }, inspectionId],
      [`/api/inspections/${inspectionId}/report-data`, { sections: [{ id: 'sec_roof', name: 'Roof', items: [{ id: 'itm_cover', name: 'Roof cover', type: 'rich' }] }], ratingLevels: [] }, inspectionId],
      ['/api/session/context', { user: { role: 'inspector', timezone: 'America/New_York', locale: 'en-US', dateFormat: 'us', timeFormat: '12h' }, branding: { tenantSlug: 'renderer-test', defaultTimezone: 'America/New_York', defaultLocale: 'en-US', dateFormat: 'us', timeFormat: '12h' }, videoProvider: 'r2', collabEditing: false }, '$global'],
      ['/api/tags', [], '$global'],
      ['/api/recommendations', [], '$global'],
      ['/api/contractor-types', [], '$global'],
      ['/api/admin/defect-categories', [], '$global'],
    ];
    await db.run('INSERT OR REPLACE INTO work_package (inspection_id, refreshed_at, pinned, scheduled_at, completed, server_confirmed, tenant_id, user_id, purging, package_gen) VALUES (?, ?, 0, ?, 0, 1, ?, ?, 0, 1)', [inspectionId, Date.now(), Date.parse('2026-11-01T10:00:00Z'), 'renderer-tenant', 'renderer-user']);
    for (const [key, data, packageId] of entries) {
      const body = JSON.stringify({ success: true, data });
      await db.run('INSERT OR REPLACE INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [accountKey, key, body, Date.now(), packageId]);
    }
  });
}

async function openEditorWithRealHeicHelper(): Promise<void> {
  await electronApp.close();
  environment.OI_E2E_HEIC_HELPER = resolve('dist-electron/native/win-heic-helper.exe');
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(({ shell }) => { shell.openExternal = async (url) => { Reflect.set(globalThis, 'rendererExternalUrl', url); }; });
  await signIn();
  await seedEditorPackage();
  await expect(page.getByRole('button', { name: 'Open 77 Test Photo Lane' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Open 77 Test Photo Lane' }).click();
  await expect(page.getByRole('button', { name: 'Open Roof cover' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Roof cover' }).click();
}

function withIrotRotation(fixture: Buffer, rotation: 1 | 2 | 3): Buffer {
  const propertyName = Buffer.from('irot');
  const propertyOffset = fixture.indexOf(propertyName);
  if (propertyOffset < 0 || fixture.indexOf(propertyName, propertyOffset + propertyName.length) >= 0) {
    throw new Error('Expected exactly one irot property in the synthetic fixture.');
  }

  const rotated = Buffer.from(fixture);
  const valueOffset = propertyOffset + propertyName.length;
  if (((rotated[valueOffset] ?? 0xff) & 0xfc) !== 0) throw new Error('Unexpected irot property encoding.');
  rotated[valueOffset] = rotation;
  return rotated;
}

test('editor reports a missing Windows codec and keeps a JPEG selected in the same batch', async () => {
  test.setTimeout(120_000);
  await signIn();
  await seedEditorPackage();
  await expect(page.getByRole('button', { name: 'Open 77 Test Photo Lane' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Open 77 Test Photo Lane' }).click();
  await expect(page.getByRole('button', { name: 'Open Roof cover' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Roof cover' }).click();

  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add from library' }).click();
  const chooser = await picker;
  const [heic, jpeg] = await Promise.all([
    readFile(resolve('src/media/heic/fixtures/fixture-64x48.heic')),
    readFile(resolve('.superpowers/sdd/plan-d2-windows-electron/helper-output.jpg')),
  ]);
  await chooser.setFiles([
    { name: 'synthetic-heic.heic', mimeType: 'image/heic', buffer: heic },
    { name: 'synthetic-control.jpg', mimeType: 'image/jpeg', buffer: jpeg },
  ]);

  await expect(page.getByText(/Windows cannot decode this HEIC photo/)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(1);
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const theme of ['light', 'dark'] as const) {
    await electronApp.evaluate(({ nativeTheme }, selected) => { nativeTheme.themeSource = selected; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    await page.screenshot({ path: `.superpowers/sdd/plan-d2-windows-electron/heic-codec-missing-batch-${theme}.png`, animations: 'disabled' });
  }
});

test('offline import reports an unsupported neighbor and still stores the valid photo', async () => {
  test.setTimeout(120_000);
  await signIn();
  await seedEditorPackage();
  await expect(page.getByRole('button', { name: 'Open 77 Test Photo Lane' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Open 77 Test Photo Lane' }).click();
  await expect(page.getByRole('button', { name: 'Open Roof cover' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Roof cover' }).click();

  const requestsBeforeOffline = engine.requests.length;
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add from library' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([
    { name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') },
    { name: 'valid.jpg', mimeType: 'image/jpeg', buffer: await readFile(resolve('.superpowers/sdd/plan-d2-windows-electron/helper-output.jpg')) },
  ]);

  await expect(page.getByText('1 photo could not be added because only JPEG, PNG and HEIC photos are supported.', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => window.oiDesktop.db.query('SELECT content_type FROM media'))).toEqual([{ content_type: 'image/jpeg' }]);
  expect(engine.requests.slice(requestsBeforeOffline).filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('an over-10-MiB HEIC is converted and stored as JPEG with original quality enabled', async () => {
  test.setTimeout(120_000);
  await openEditorWithRealHeicHelper();

  await page.getByRole('button', { name: 'Report settings' }).click();
  const originalQuality = page.getByTestId('original-quality-uploads');
  await expect(originalQuality).toBeVisible();
  await originalQuality.check();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  const source = await readFile(resolve('src/media/heic/fixtures/fixture-64x48.heic'));
  const boxBytes = 12 * 1024 * 1024;
  const freeBox = Buffer.alloc(boxBytes);
  freeBox.writeUInt32BE(boxBytes, 0);
  freeBox.write('free', 4, 'ascii');
  const oversizedHeic = Buffer.concat([source, freeBox]);
  expect(oversizedHeic.byteLength).toBeGreaterThan(10 * 1024 * 1024);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add from library' }).click();
  await (await chooserPromise).setFiles({ name: 'large-synthetic.heic', mimeType: 'image/heic', buffer: oversizedHeic });

  await expect.poll(async () => page.evaluate(() => window.oiDesktop.db.query('SELECT pending_id, path, content_type FROM media')), { timeout: 45_000 }).toEqual([
    expect.objectContaining({ content_type: 'image/jpeg' }),
  ]);
  const [{ path: mediaPath }] = await page.evaluate(() => window.oiDesktop.db.query('SELECT path FROM media')) as Array<{ path: string }>;
  const relativeMediaPath = mediaPath.replace(/^media[\\/]/, '');
  const jpeg = await readFile(join(userData, 'media', relativeMediaPath));
  expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect(jpeg.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('real Electron HEIC import applies all irot quarter-turns before persisting JPEG', async () => {
  test.setTimeout(120_000);
  await openEditorWithRealHeicHelper();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add from library' }).click();
  const baseline = await readFile(resolve('src/media/heic/fixtures/fixture-64x48.heic'));
  const rotated90 = await readFile(resolve('src/media/heic/fixtures/fixture-rot90.heic'));
  await (await picker).setFiles([
    { name: 'baseline.heic', mimeType: 'image/heic', buffer: baseline },
    { name: 'rotated-90.heic', mimeType: 'image/heic', buffer: rotated90 },
    { name: 'rotated-180.heic', mimeType: 'image/heic', buffer: withIrotRotation(rotated90, 2) },
    { name: 'rotated-270.heic', mimeType: 'image/heic', buffer: withIrotRotation(rotated90, 3) },
  ]);

  await expect.poll(async () => page.evaluate(() => window.oiDesktop.db.query('SELECT path, content_type FROM media ORDER BY rowid')), { timeout: 30_000 }).toEqual([
    expect.objectContaining({ content_type: 'image/jpeg' }),
    expect.objectContaining({ content_type: 'image/jpeg' }),
    expect.objectContaining({ content_type: 'image/jpeg' }),
    expect.objectContaining({ content_type: 'image/jpeg' }),
  ]);
  const mediaRows = await page.evaluate(() => window.oiDesktop.db.query('SELECT path FROM media ORDER BY rowid')) as Array<{ path: string }>;
  const jpegs = await Promise.all(mediaRows.map(({ path: mediaPath }) => readFile(join(userData, 'media', mediaPath.replace(/^media[\\/]/, '')))));
  const dimensions = jpegs.map((jpeg): [number, number] | undefined => {
    for (let offset = 2; offset + 9 < jpeg.length;) {
      if (jpeg[offset] !== 0xff) { offset++; continue; }
      const marker = jpeg[offset + 1];
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return [jpeg.readUInt16BE(offset + 7), jpeg.readUInt16BE(offset + 5)];
      }
      const segmentLength = jpeg.readUInt16BE(offset + 2);
      if (segmentLength < 2) break;
      offset += 2 + segmentLength;
    }
    return undefined;
  });
  expect(dimensions).toEqual([[64, 48], [48, 64], [64, 48], [48, 64]]);
  const meanRotatedPixelErrors = await page.evaluate(async (encoded) => {
    const decode = async (bytes: number[]) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2d canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      return { width: bitmap.width, height: bitmap.height, pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data };
    };
    const baseline = await decode(encoded[0] ?? []);
    const errors: number[] = [];
    for (const [rotatedIndex, rotation] of [[1, 1], [2, 2], [3, 3]] as const) {
      const rotated = await decode(encoded[rotatedIndex] ?? []);
      let error = 0;
      let channels = 0;
      for (let y = 0; y < baseline.height; y++) for (let x = 0; x < baseline.width; x++) {
        const sourceOffset = (y * baseline.width + x) * 4;
        let targetX = x;
        let targetY = y;
        if (rotation === 1) { targetX = y; targetY = baseline.width - 1 - x; }
        else if (rotation === 2) { targetX = baseline.width - 1 - x; targetY = baseline.height - 1 - y; }
        else { targetX = baseline.height - 1 - y; targetY = x; }
        const targetOffset = (targetY * rotated.width + targetX) * 4;
        for (let channel = 0; channel < 3; channel++) {
          error += Math.abs(baseline.pixels[sourceOffset + channel] - rotated.pixels[targetOffset + channel]);
          channels++;
        }
      }
      errors.push(error / channels);
    }
    return errors;
  }, jpegs.map((jpeg) => Array.from(jpeg)));
  expect(meanRotatedPixelErrors).toHaveLength(3);
  for (const error of meanRotatedPixelErrors) expect(error).toBeLessThan(12);
  for (const theme of ['light', 'dark'] as const) {
    await electronApp.evaluate(({ nativeTheme }, selectedTheme) => { nativeTheme.themeSource = selectedTheme; }, theme);
    await expect.poll(() => electronApp.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors)).toBe(theme === 'dark');
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    await page.screenshot({ path: `.superpowers/sdd/plan-d2-windows-electron/heic-rotation-editor-${theme}.png`, animations: 'disabled' });
  }
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('real Electron editor stores a Display P3 HEIC as an sRGB JPEG', async () => {
  test.setTimeout(120_000);
  await openEditorWithRealHeicHelper();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add from library' }).click();
  await (await chooserPromise).setFiles({
    name: 'display-p3.heic',
    mimeType: 'image/heic',
    buffer: await readFile(resolve('src/media/heic/fixtures/fixture-p3.heic')),
  });

  await expect.poll(() => page.evaluate(() => window.oiDesktop.db.query('SELECT path, content_type FROM media'))).toEqual([
    expect.objectContaining({ content_type: 'image/jpeg' }),
  ]);
  const [{ path: mediaPath }] = await page.evaluate(() => window.oiDesktop.db.query('SELECT path FROM media')) as Array<{ path: string }>;
  const jpeg = await readFile(join(userData, 'media', mediaPath.replace(/^media[\\/]/, '')));
  const actual = await page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixel = context.getImageData(32, 24, 1, 1).data;
    return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
  }, jpeg.toString('base64'));
  const expected = [249, 61, 0];
  const encodedP3 = [230, 80, 30];
  for (const [index, channel] of actual.entries()) {
    const expectedChannel = expected[index] ?? 0;
    expect(Math.abs(channel - expectedChannel)).toBeLessThan(Math.abs((encodedP3[index] ?? 0) - expectedChannel));
    expect(Math.abs(channel - expectedChannel)).toBeLessThanOrEqual(24);
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  for (const theme of ['light', 'dark'] as const) {
    await electronApp.evaluate(({ nativeTheme }, selectedTheme) => { nativeTheme.themeSource = selectedTheme; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    await page.screenshot({ path: `.superpowers/sdd/plan-d2-windows-electron/heic-p3-editor-${theme}.png`, animations: 'disabled' });
  }
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('a HEIC with an oversized primary ispe is rejected and the batch continues', async () => {
  test.setTimeout(120_000);
  await openEditorWithRealHeicHelper();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add from library' }).click();
  await (await chooserPromise).setFiles([
    { name: 'too-many-pixels.heic', mimeType: 'image/heic', buffer: await readFile(resolve('src/media/heic/fixtures/fixture-bomb-ispe.heic')) },
    { name: 'valid.jpg', mimeType: 'image/jpeg', buffer: await readFile(resolve('.superpowers/sdd/plan-d2-windows-electron/helper-output.jpg')) },
  ]);

  await expect(page.getByText(/A photo could not be converted and was skipped\. This HEIC photo has more pixels than Windows can decode\./)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.oiDesktop.db.query('SELECT content_type FROM media'))).toEqual([{ content_type: 'image/jpeg' }]);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('a corrupt HEIC is skipped with a visible batch result and the next photo is stored', async () => {
  test.setTimeout(120_000);
  await openEditorWithRealHeicHelper();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  await page.getByRole('button', { name: 'Add from library' }).click();
  await (await chooserPromise).setFiles([
    { name: 'corrupt.heic', mimeType: 'image/heic', buffer: await readFile(resolve('src/media/heic/fixtures/corrupt.heic')) },
    { name: 'valid.jpg', mimeType: 'image/jpeg', buffer: await readFile(resolve('.superpowers/sdd/plan-d2-windows-electron/helper-output.jpg')) },
  ]);

  await expect(page.getByText(/A photo could not be converted and was skipped\. This HEIC photo is damaged or could not be decoded\./)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => window.oiDesktop.db.query('SELECT content_type FROM media'))).toEqual([{ content_type: 'image/jpeg' }]);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});
