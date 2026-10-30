import { _electron, expect, test, type ElectronApplication, type FileChooser, type Page } from '@playwright/test';
import { build as viteBuild } from 'vite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopBridge } from '../electron/shared/ipc-contract.ts';
import { startRendererEngine, type RendererEngine } from './fixtures/renderer-engine.ts';

declare global {
  interface Window {
    oiDesktop: DesktopBridge;
    __oiE2ESelectedFiles?: Array<{ name: string; type: string; size: number }>;
    __oiE2EEditorState?: {
      isOnline(): boolean;
      hasLiveDoc(): boolean;
      storePuts: Array<{ contentType: string; size: number; outcome: 'stored' | 'rejected'; code?: string }>;
    };
  }
}

const execFileAsync = promisify(execFile);
const DEV_RENDERER = resolve('dist-electron/renderer-development');

test.beforeAll(async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    await viteBuild({ configFile: resolve('vite.electron.config.ts'), mode: 'development', build: { outDir: DEV_RENDERER, emptyOutDir: true } });
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

let electronApp: ElectronApplication;
let page: Page;
let userData: string;
let engine: RendererEngine;
let environment: Record<string, string>;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-photo-import-'));
  engine = await startRendererEngine({ showInspection: true });
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OI_USER_DATA_DIR = userData;
  environment.OI_RENDERER_ROOT = DEV_RENDERER;
  environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  environment.OI_E2E_HEIC_HELPER = resolve('.superpowers/sdd/plan-d2-windows-electron/helper-codec-missing.exe');
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  page = await electronApp.firstWindow();
  await expect(page.getByRole('heading', { name: 'Choose your server' })).toBeVisible();
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
  if (!state) throw new Error('photo-import-auth-state-missing');
  const callback = new URL('io.inspectorhub.app:/oauth/callback');
  callback.searchParams.set('code', 'renderer-code');
  callback.searchParams.set('state', state);
  const executable = await electronApp.evaluate(() => process.execPath);
  const child = spawn(executable, ['dist-electron/main/index.cjs', callback.href], { cwd: process.cwd(), env: environment, windowsHide: true, stdio: 'ignore' });
  const exit = await new Promise<number | null>((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
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
      ['/api/tags', [], '$global'], ['/api/recommendations', [], '$global'], ['/api/contractor-types', [], '$global'], ['/api/admin/defect-categories', [], '$global'],
    ];
    await db.run('INSERT OR REPLACE INTO work_package (inspection_id, refreshed_at, pinned, scheduled_at, completed, server_confirmed, tenant_id, user_id, purging, package_gen) VALUES (?, ?, 0, ?, 0, 1, ?, ?, 0, 1)', [inspectionId, Date.now(), Date.parse('2026-11-01T10:00:00Z'), 'renderer-tenant', 'renderer-user']);
    for (const [key, data, packageId] of entries) {
      await db.run('INSERT OR REPLACE INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [accountKey, key, JSON.stringify({ success: true, data }), Date.now(), packageId]);
    }
  });
  await expect(page.getByRole('button', { name: 'Open 77 Test Photo Lane' })).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Open 77 Test Photo Lane' }).click();
  await expect(page.getByRole('button', { name: 'Open Roof cover' })).toBeVisible();
  await page.getByRole('button', { name: 'Open Roof cover' }).click();
}

async function mediaRows(): Promise<Array<{ pending_id: string; path: string; content_type: string }>> {
  return page.evaluate(() => window.oiDesktop.db.query('SELECT pending_id, path, content_type FROM media ORDER BY pending_id'));
}

async function openLibrary(): Promise<FileChooser> {
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add from library' }).click();
  return picker;
}

async function openReportSettings(): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('button', { name: 'Report settings' }).click();
}

test('a file dropped on the renderer is cancelled and does not navigate', async () => {
  const before = page.url();
  const prevented = await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['drop payload'], 'notes.txt', { type: 'text/plain' }));
    const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
    document.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await page.waitForTimeout(100);
  expect(page.url()).toBe(before);
});

test('imports valid photos and reports an unsupported neighbor in the same library batch', async () => {
  await signIn();
  await seedEditorPackage();
  await page.locator('input[type=file][multiple]').evaluate((element) => element.removeAttribute('accept'));
  const libraryPicker = await openLibrary();
  const jpeg = await readFile(resolve('e2e-electron/fixtures/photo-import.jpg'));
  const png = await readFile(resolve('android/app/src/main/res/drawable/splash.png'));
  const partialFailure = page.getByText('2 of 3 photos uploaded — 1 failed.', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 });
  await (await libraryPicker).setFiles([
    { name: 'valid.jpg', mimeType: 'image/jpeg', buffer: jpeg },
    { name: 'valid.png', mimeType: 'image/png', buffer: png },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') },
  ]);
  await partialFailure;
  await expect(page.getByText('2 photos', { exact: true })).toBeVisible();
  await expect.poll(() => engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(2);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: '.superpowers/sdd/plan-d2-windows-electron/photo-import-refusal-light-1280.png', animations: 'disabled' });
  await electronApp.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe('dark');
  await page.screenshot({ path: '.superpowers/sdd/plan-d2-windows-electron/photo-import-refusal-dark-1280.png', animations: 'disabled' });
  await expect(page.getByText('2 of 3 photos uploaded — 1 failed.', { exact: true })).toBeHidden({ timeout: 10_000 });
  for (const theme of ['light', 'dark'] as const) {
    await electronApp.evaluate(({ nativeTheme }, selected) => { nativeTheme.themeSource = selected; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    await page.screenshot({ path: `.superpowers/sdd/plan-d2-windows-electron/photo-import-success-${theme}-1280.png`, animations: 'disabled' });
  }
  await page.setViewportSize({ width: 600, height: 800 });
  await page.getByRole('button', { name: 'Add photo', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Add media' })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await electronApp.evaluate(({ nativeTheme }, selected) => { nativeTheme.themeSource = selected; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    await page.screenshot({ path: `.superpowers/sdd/plan-d2-windows-electron/photo-import-chooser-${theme}-600.png`, animations: 'disabled' });
  }
  const narrowPicker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Add from library' }).click();
  await (await narrowPicker).setFiles({ name: 'narrow.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  await expect(page.getByText('3 photos', { exact: true })).toBeVisible();
});

test('a missing Windows codec skips only the HEIC while the JPEG in its batch uploads', async () => {
  await signIn();
  await seedEditorPackage();
  const [heic, jpeg] = await Promise.all([
    readFile(resolve('src/media/heic/fixtures/fixture-64x48.heic')),
    readFile(resolve('e2e-electron/fixtures/photo-import.jpg')),
  ]);
  const chooser = await openLibrary();
  await chooser.setFiles([
    { name: 'codec-missing.heic', mimeType: 'image/heic', buffer: heic },
    { name: 'valid.jpg', mimeType: 'image/jpeg', buffer: jpeg },
  ]);

  await expect(page.getByText(/Windows cannot decode this HEIC photo.*Install HEIF Image Extensions.*HEVC Video Extensions.*export the photo from your phone as JPEG/s)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(1);
  expect(engine.uploads.size).toBe(1);
  expect(engine.uploadCounts.size).toBe(1);
});

test('offline import explains an unsupported file and still stores its valid neighbor', async () => {
  test.setTimeout(120_000);
  await signIn();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await seedEditorPackage();
  await page.getByRole('textbox', { name: 'Notes' }).fill('offline import readiness');
  await expect.poll(() => page.evaluate(async () => {
    const rows = await window.oiDesktop.db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM ydoc_updates WHERE doc_name = ?',
      ['results-insp-7'],
    );
    return rows[0]?.n ?? 0;
  })).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => ({
    online: window.__oiE2EEditorState?.isOnline() ?? null,
    hasLiveDoc: window.__oiE2EEditorState?.hasLiveDoc() ?? false,
  }))).toEqual({ online: false, hasLiveDoc: true });
  const jpeg = await readFile(resolve('e2e-electron/fixtures/photo-import.jpg'));
  const input = page.locator('input[type=file][multiple]');
  await expect(input).toHaveCount(1);
  await input.evaluate((element) => element.removeAttribute('accept'));
  await input.evaluate((element) => {
    element.addEventListener('change', (event) => {
      const target = event.currentTarget as HTMLInputElement;
      window.__oiE2ESelectedFiles = Array.from(target.files ?? [], ({ name, type, size }) => ({ name, type, size }));
    }, { capture: true, once: true });
  });
  const refusal = page.getByText('1 photo could not be added because only JPEG, PNG and HEIC photos are supported.', { exact: true })
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => true, () => false);
  await input.setInputFiles([
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') },
    { name: 'valid.jpg', mimeType: 'image/jpeg', buffer: jpeg },
  ]);
  await expect.poll(() => page.evaluate(() => window.__oiE2ESelectedFiles)).toEqual([
    { name: 'notes.txt', type: 'text/plain', size: 11 },
    { name: 'valid.jpg', type: 'image/jpeg', size: jpeg.length },
  ]);
  await expect.poll(() => page.evaluate(() => window.__oiE2EEditorState?.storePuts), { timeout: 30_000 }).toHaveLength(2);
  const storePuts = await page.evaluate(() => window.__oiE2EEditorState?.storePuts ?? []);
  expect(storePuts).toHaveLength(2);
  expect(storePuts[0]).toEqual({ contentType: 'text/plain', size: 11, outcome: 'rejected', code: 'UNSUPPORTED_TYPE' });
  expect(storePuts[1]).toMatchObject({ contentType: 'image/jpeg', outcome: 'stored' });
  expect(storePuts[1]?.size).toBeGreaterThan(0);
  await expect(refusal).resolves.toBe(true);
  const refusalLocator = page.getByText('1 photo could not be added because only JPEG, PNG and HEIC photos are supported.', { exact: true });
  for (const theme of ['light', 'dark'] as const) {
    await electronApp.evaluate(({ nativeTheme }, selected) => { nativeTheme.themeSource = selected; }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    await expect(refusalLocator).toBeVisible();
    await page.screenshot({ path: `.superpowers/sdd/plan-d2-windows-electron/offline-photo-refusal-${theme}-1280.png`, animations: 'disabled' });
  }
  await expect.poll(async () => mediaRows()).toHaveLength(1);
  expect((await mediaRows())[0]?.content_type).toBe('image/jpeg');
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('a spoofed JPEG is rejected before reaching the media store', async () => {
  await signIn();
  await seedEditorPackage();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  const libraryPicker = await openLibrary();
  await (await libraryPicker).setFiles([{ name: 'fake.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('MZ payload') }]);
  const rejected = page.getByText(/1 photo could not be added/).waitFor({ state: 'visible', timeout: 15_000 }).then(() => 'rejected');
  const stored = expect.poll(() => readdir(join(userData, 'media')).then((files) => files.length), { timeout: 15_000 })
    .toBeGreaterThan(0).then(() => 'stored');
  await expect(Promise.race([rejected, stored])).resolves.toBe('rejected');
  await expect.poll(async () => mediaRows()).toHaveLength(0);
  await expect.poll(() => readdir(join(userData, 'media'))).toEqual([]);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('caps a 25-photo offline selection at 20 and shows the capped-batch notice', async () => {
  test.setTimeout(120_000);
  await signIn();
  await seedEditorPackage();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  const jpeg = await readFile(resolve('e2e-electron/fixtures/photo-import.jpg'));
  const chooser = await openLibrary();
  await chooser.setFiles(Array.from({ length: 25 }, (_, index) => ({
    name: `photo-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: jpeg,
  })));

  await expect.poll(async () => (await mediaRows()).length, { timeout: 60_000 }).toBe(20);
  await expect(page.getByText('Added the first 20 photos; add the rest in another batch.', { exact: true })).toBeVisible();
  expect((await mediaRows()).every((row) => row.content_type === 'image/jpeg')).toBe(true);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});

test('the batch survives a force-kill and each persisted photo uploads once after restart', async () => {
  test.setTimeout(120_000);
  await signIn();
  await seedEditorPackage();
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

  const jpeg = await readFile(resolve('e2e-electron/fixtures/photo-import.jpg'));
  const picker = await openLibrary();
  await (await picker).setFiles(Array.from({ length: 3 }, (_, index) => ({
    name: `persist-${index + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: jpeg,
  })));
  await expect.poll(async () => (await mediaRows()).length, { timeout: 30_000 }).toBe(3);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);

  const beforeKill = await mediaRows();
  for (const row of beforeKill) {
    expect(row.content_type).toBe('image/jpeg');
    const file = await readFile(join(userData, 'media', row.path.replace(/^media[\\/]/, '')));
    expect(file.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }

  const killedApp = electronApp;
  const pid = killedApp.process().pid;
  if (pid === undefined) throw new Error('photo-import-main-pid-missing');
  const exited = new Promise<void>((resolveExit) => killedApp.process().once('exit', () => resolveExit()));
  await execFileAsync('taskkill.exe', ['/F', '/PID', String(pid)]);
  await exited;
  await killedApp.close().catch(() => undefined);

  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(({ shell }) => { shell.openExternal = async (url) => { Reflect.set(globalThis, 'rendererExternalUrl', url); }; });
  await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 20_000 });
  await expect.poll(
    () => page.evaluate(() => window.oiDesktop.db.query('SELECT 1 AS ready')),
    { timeout: 15_000 },
  ).toEqual([{ ready: 1 }]);
  await expect.poll(async () => mediaRows(), { timeout: 15_000 }).toHaveLength(3);

  const afterRestart = await mediaRows();
  expect(afterRestart).toHaveLength(3);
  expect(afterRestart.map(({ pending_id }) => pending_id).sort()).toEqual(beforeKill.map(({ pending_id }) => pending_id).sort());
  for (const row of afterRestart) {
    const file = await readFile(join(userData, 'media', row.path.replace(/^media[\\/]/, '')));
    expect(file.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  }

  await expect.poll(() => engine.uploads.size, { timeout: 30_000 }).toBe(3);
  expect(engine.uploadCounts.size).toBe(3);
  expect([...engine.uploadCounts.values()]).toEqual([1, 1, 1]);
  expect(engine.uploadContentLengths).toHaveLength(3);
  expect(engine.uploadContentLengths.every((length) => length !== null && length > 0)).toBe(true);
  await page.waitForTimeout(500);
  expect([...engine.uploadCounts.values()]).toEqual([1, 1, 1]);
});

test('original-quality keeps a large JPEG unchanged and rejects it, while normal quality recompresses it', async () => {
  test.setTimeout(120_000);
  await signIn();
  await seedEditorPackage();

  await openReportSettings();
  const originalQuality = page.getByTestId('original-quality-uploads');
  await expect(originalQuality).toBeVisible();
  await originalQuality.check();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('oi.uploads.originalQuality'))).toBe('1');
  await page.getByRole('button', { name: 'Close' }).click();

  const jpeg = await readFile(resolve('e2e-electron/fixtures/photo-import.jpg'));
  const oversizedJpeg = Buffer.concat([jpeg, Buffer.alloc(12 * 1024 * 1024 - jpeg.length)]);
  const input = page.locator('input[type=file][multiple]');
  await input.setInputFiles({ name: 'large.jpg', mimeType: 'image/jpeg', buffer: oversizedJpeg });
  await expect(page.getByText(/0 of 1 photos uploaded.*1 failed/)).toBeVisible({ timeout: 20_000 });
  expect(await mediaRows()).toEqual([]);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);

  await openReportSettings();
  await expect(originalQuality).toBeVisible();
  await originalQuality.uncheck();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('oi.uploads.originalQuality'))).toBeNull();
  await input.setInputFiles({ name: 'large.jpg', mimeType: 'image/jpeg', buffer: oversizedJpeg });
  await expect.poll(() => engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(1);
  await expect.poll(() => engine.uploads.size).toBe(1);
  expect(engine.uploadContentLengths).toHaveLength(1);
  expect(engine.uploadContentLengths[0]).toBeLessThan(1024 * 1024);
  expect(engine.uploads.size).toBe(1);
});
