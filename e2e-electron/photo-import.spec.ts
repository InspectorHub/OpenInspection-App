import { _electron, expect, test, type ElectronApplication, type FileChooser, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { DesktopBridge } from '../electron/shared/ipc-contract.ts';
import { startRendererEngine, type RendererEngine } from './fixtures/renderer-engine.ts';

declare global { interface Window { oiDesktop: DesktopBridge } }

let electronApp: ElectronApplication;
let page: Page;
let userData: string;
let engine: RendererEngine;
let environment: Record<string, string>;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-photo-import-'));
  engine = await startRendererEngine();
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OI_USER_DATA_DIR = userData;
  environment.OI_RENDERER_ROOT = resolve('dist-electron/renderer');
  environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
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
  const jpeg = await readFile(resolve('.superpowers/sdd/plan-d2-windows-electron/helper-output.jpg'));
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

test('a spoofed JPEG is rejected before reaching the media store', async () => {
  await signIn();
  await seedEditorPackage();
  const libraryPicker = await openLibrary();
  await (await libraryPicker).setFiles([{ name: 'fake.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('MZ payload') }]);
  await expect(page.getByText(/0 of 1 photos uploaded.*1 failed/)).toBeVisible({ timeout: 15_000 });
  expect(await mediaRows()).toEqual([]);
  expect(engine.requests.filter((request) => request === 'POST /api/public/uploads/photo')).toHaveLength(0);
});
