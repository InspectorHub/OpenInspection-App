import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { build as viteBuild } from 'vite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge } from '../electron/shared/ipc-contract';
import { startRendererEngine, type RendererEngine } from './fixtures/renderer-engine';

declare global {
  interface Window { oiDesktop: DesktopBridge; }
}

const VIEWPORTS = [
  { width: 1280, height: 800, key: '1280x800' },
  { width: 800, height: 600, key: '800x600' },
  { width: 480, height: 720, key: '480x720' },
] as const;
const SCREENSHOT_ROOT = '.superpowers/sdd/plan-d2-windows-electron/screenshots/task-12';
const UPDATER_SCREENSHOT_ROOT = '.superpowers/sdd/plan-d2-windows-electron/screenshots/updater-transaction-guard';
const DEV_RENDERER = 'dist-electron/renderer-development';
let electronApp: ElectronApplication | undefined;
let page: Page | undefined;
let userData = '';
let engine: RendererEngine | undefined;
let environment: Record<string, string> = {};
const browserErrors: string[] = [];
let browserStage = 'startup';

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

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-renderer-'));
  engine = await startRendererEngine();
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OI_USER_DATA_DIR = userData;
  environment.OI_RENDERER_ROOT = resolve('dist-electron/renderer');
  environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  browserErrors.length = 0;
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  page = await electronApp.firstWindow();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Runtime.enable');
  cdp.on('Runtime.exceptionThrown', (event) => browserErrors.push(`cdp exception: ${JSON.stringify(event.exceptionDetails)}`));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`${browserStage} console: ${message.text()} (${message.location().url})`); });
  page.on('pageerror', (error) => browserErrors.push(`${browserStage} pageerror: ${error.name}: ${error.message}\n${error.stack ?? ''}`));
  page.on('requestfailed', (request) => browserErrors.push(`${browserStage} requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  await electronApp.evaluate(({ shell }) => {
    shell.openExternal = async (url) => { Reflect.set(globalThis, 'rendererExternalUrl', url); };
  });
});

test.afterEach(async () => {
  await electronApp?.close();
  await engine?.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  electronApp = undefined;
  page = undefined;
  engine = undefined;
});

async function captureMatrix(state: 'setup' | 'sign-in' | 'settings' | 'locked', focus?: string): Promise<void> {
  if (!electronApp || !page) throw new Error('renderer-not-running');
  await mkdir(SCREENSHOT_ROOT, { recursive: true });
  if (state === 'settings') {
    await page.getByRole('heading', { name: 'Desktop app' }).scrollIntoViewIfNeeded();
    if (focus) {
      await page.keyboard.press('Tab');
      await page.getByRole('button', { name: focus }).focus();
    }
  } else {
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  for (const theme of ['light', 'dark'] as const) {
    await electronApp.evaluate(({ nativeTheme }, selected) => { nativeTheme.themeSource = selected; }, theme);
    const nativeThemeState = await electronApp.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }));
    expect(nativeThemeState).toEqual({ source: theme, dark: theme === 'dark' });
    // The Windows Electron runner does not propagate nativeTheme changes to an already-open renderer media query.
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page!.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.screenshot({ path: join(SCREENSHOT_ROOT, `${state}-${theme}-${viewport.key}.png`), animations: 'disabled' });
    }
  }
}

async function signInOnTestEngine(): Promise<void> {
  if (!electronApp || !page || !engine) throw new Error('renderer-not-running');
  await expect.poll(async () => page!.locator('h1').first().innerText().catch(() => ''), { timeout: 10_000 })
    .toMatch(/^(Choose your server|Sign in|Work list)$/);
  if (await page.getByLabel('Server address').count()) {
    await page.getByLabel('Server address').fill(engine.url);
    await page.getByRole('button', { name: 'Continue' }).click();
    browserStage = 'server-connect';
    await page.getByRole('button', { name: 'Connect' }).click();
  }
  const diagnostics = `Page URL: ${page.url()}\nCurrent page:\n${await page.locator('body').innerText()}\nEngine requests:\n${engine.requests.join('\n')}\nBrowser errors:\n${browserErrors.join('\n')}\nMain log:\n${await readFile(join(userData, 'logs', 'main.log'), 'utf8').catch(() => 'unavailable')}`;
  await expect(
    page.getByRole('heading', { name: 'Sign in' }),
    `Server connection did not reach sign-in. ${diagnostics}`,
  ).toBeVisible();
  browserStage = 'oauth-open';
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => electronApp!.evaluate(() => Reflect.get(globalThis, 'rendererExternalUrl'))).toEqual(expect.stringContaining('/oauth/authorize?'));
  const authorizeUrl = String(await electronApp.evaluate(() => Reflect.get(globalThis, 'rendererExternalUrl')));
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (!state) throw new Error('renderer-auth-state-missing');
  const callback = new URL('io.inspectorhub.app:/oauth/callback');
  callback.searchParams.set('code', 'renderer-code');
  callback.searchParams.set('state', state);
  const executable = await electronApp.evaluate(() => process.execPath);
  browserStage = 'oauth-callback';
  const child = spawn(executable, ['dist-electron/main/index.cjs', callback.href], { cwd: process.cwd(), env: environment, windowsHide: true, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  browserStage = 'post-login';
  await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 20_000 });
}

test('built renderer stays on https://localhost and covers the desktop visual matrix', async () => {
  test.setTimeout(120_000);
  if (!electronApp || !page || !engine) throw new Error('renderer-not-running');
  browserStage = 'setup';
  expect(page.url()).toBe('https://localhost/');
  await expect(page.getByRole('heading', { name: 'Choose your server' })).toBeVisible();
  await expect(page.getByLabel('Server address')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Diagnostics (development only)' })).toHaveCount(0);
  await captureMatrix('setup');

  await page.getByLabel('Server address').fill(engine.url);
  await page.getByRole('button', { name: 'Continue' }).click();
  browserStage = 'server-connect';
  await page.getByRole('button', { name: 'Connect' }).click();
  browserStage = 'sign-in';
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await captureMatrix('sign-in');

  await signInOnTestEngine();
  browserStage = 'settings';
  await expect(page.getByRole('button', { name: 'Diagnostics (development only)' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Desktop app' })).toBeVisible();
  await expect(page.getByText('Updates are turned off in this build')).toBeVisible();
  await expect(page.getByText('Uploads continue only while InspectorHub is open.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await captureMatrix('settings', 'Open log folder');

  await page.evaluate(() => { window.oiDesktop.updater.onState((state) => { document.body.dataset.updaterEvent = state.kind; }); });
  browserStage = 'updater';
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('updater:state-changed', { kind: 'checking' }));
  await expect.poll(() => page!.locator('body').getAttribute('data-updater-event')).toBe('checking');
  await expect(page.getByText('Checking for updates')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check for updates' })).toBeDisabled();
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('updater:state-changed', { kind: 'error', code: 'network' }));
  await expect(page.getByText('Could not check for updates')).toBeVisible();
  await page.getByRole('button', { name: 'Back to work list' }).click();

  const old = String(Date.now() - 31 * 86_400_000);
  browserStage = 'lock';
  await page.evaluate(async (oldValue) => {
    await window.oiDesktop.db.run("UPDATE device_state SET value = ? WHERE key IN ('last_verified_at', 'max_seen_time')", [oldValue]);
  }, old);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('app:active-change', true));
  await expect(page.getByRole('heading', { name: 'Verification needed' })).toBeVisible({ timeout: 10_000 });
  await captureMatrix('locked');

  expect(browserErrors.filter((line) => /Refused to|Content Security Policy|CSP/i.test(line))).toEqual([]);
  const mainLog = await readFile(join(userData, 'logs', 'main.log'), 'utf8').catch(() => 'unavailable');
  expect(browserErrors, `main.log:\n${mainLog}\nengine requests:\n${engine.requests.join('\n')}`).toEqual([]);
});

test('development renderer exposes Diagnostics and all checks pass against the fake engine', async () => {
  test.setTimeout(120_000);
  if (!electronApp || !page || !engine) throw new Error('renderer-not-running');
  browserStage = 'dev-restart';
  await electronApp.close();
  environment.OI_RENDERER_ROOT = resolve(DEV_RENDERER);
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  page = await electronApp.firstWindow();
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(`${browserStage} console: ${message.text()} (${message.location().url})`); });
  page.on('pageerror', (error) => browserErrors.push(`${browserStage} pageerror: ${error.name}: ${error.message}\n${error.stack ?? ''}`));
  page.on('requestfailed', (request) => browserErrors.push(`${browserStage} requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  await electronApp.evaluate(({ shell }) => { shell.openExternal = async (url) => { Reflect.set(globalThis, 'rendererExternalUrl', url); }; });
  await expect(page.getByRole('button', { name: 'Diagnostics (development only)' })).toBeVisible();
  browserStage = 'dev-sign-in';
  await signInOnTestEngine();
  await expect(page.getByRole('button', { name: 'Diagnostics (development only)' })).toBeVisible();
  await page.getByRole('button', { name: 'Diagnostics (development only)' }).click();
  browserStage = 'diagnostics';
  await page.getByLabel('Inspection id').fill('insp-7');
  await page.getByRole('button', { name: 'Run all' }).click();
  await expect(page.getByTestId('summary')).toContainText('collab-ticket PASS', { timeout: 60_000 });
  const results = await page.getByTestId('summary').innerText();
  for (const check of ['db-blob', 'db-tx', 'yjs-persist', 'files', 'lock-clock', 'uploader-photo', 'permissions', 'collab-ticket']) {
    expect(results).toContain(`${check} PASS`);
  }
  const mainLog = await readFile(join(userData, 'logs', 'main.log'), 'utf8').catch(() => 'unavailable');
  expect(browserErrors, `main.log:\n${mainLog}\nengine requests:\n${engine.requests.join('\n')}`).toEqual([]);
});

test('update-required screen explains a blocked database transaction in light and dark themes', async () => {
  test.setTimeout(120_000);
  if (!electronApp || !page || !engine) throw new Error('renderer-not-running');
  engine.setCompatibility({ minSupported: '0.2.0', downloadUrl: 'https://downloads.example.test/windows' });
  await signInOnTestEngine();
  browserStage = 'transaction-blocked-update';
  await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Update required' })).toBeVisible();

  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('updater:install-and-restart');
    ipcMain.handle('updater:install-and-restart', async () => {
      Reflect.set(globalThis, '__rendererE2eUpdaterInstallCalls', Number(Reflect.get(globalThis, '__rendererE2eUpdaterInstallCalls') ?? 0) + 1);
      return { ok: true, value: 'blocked-transaction' };
    });
  });
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.send('updater:state-changed', { kind: 'ready', version: '0.2.0' }));
  await page.getByRole('button', { name: 'Restart to update' }).click();
  const feedback = page.getByText('Finish or cancel the current edit before restarting to update.');
  await expect(feedback, `Updater feedback missing. Page:\n${await page.locator('body').innerText()}\nIPC calls: ${await electronApp.evaluate(() => Reflect.get(globalThis, '__rendererE2eUpdaterInstallCalls'))}\nBrowser errors:\n${browserErrors.join('\n')}`).toBeVisible();
  expect(await electronApp.evaluate(() => Reflect.get(globalThis, '__rendererE2eUpdaterInstallCalls'))).toBe(1);
  await mkdir(UPDATER_SCREENSHOT_ROOT, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page!.evaluate(() => document.documentElement.dataset.colorScheme)).toBe(theme);
    for (const viewport of [{ width: 1280, height: 800 }, { width: 480, height: 720 }] as const) {
      await page.setViewportSize(viewport);
      await page.screenshot({ path: join(UPDATER_SCREENSHOT_ROOT, `required-${theme}-${viewport.width}x${viewport.height}.png`), animations: 'disabled' });
      await expect(feedback).toBeVisible();
    }
  }

  const mainLog = await readFile(join(userData, 'logs', 'main.log'), 'utf8').catch(() => 'unavailable');
  expect(browserErrors, `main.log:\n${mainLog}\nengine requests:\n${engine.requests.join('\n')}`).toEqual([]);
});
