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
