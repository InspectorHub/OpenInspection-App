import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { build as viteBuild } from 'vite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startRendererEngine, type RendererEngine } from './renderer-engine';
import type { DesktopBridge } from '../../electron/shared/ipc-contract';

declare global { interface Window { oiDesktop: DesktopBridge; } }

const execFileAsync = promisify(execFile);
const DEV_RENDERER = 'dist-electron/renderer-development';
export const TASK16_SCREENSHOT_ROOT = '.superpowers/sdd/2026-10-27-native-client-plan-d2-windows-electron/screenshots/task-16';

export async function prepareDesktopRenderer(): Promise<void> {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    await viteBuild({ configFile: resolve('vite.electron.config.ts'), mode: 'development', build: { outDir: DEV_RENDERER, emptyOutDir: true } });
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
}

export interface DesktopHarness {
  app: ElectronApplication;
  page: Page;
  userData: string;
  engine: RendererEngine;
  environment: Record<string, string>;
  errors: string[];
  restartGracefully(): Promise<void>;
  restartAfterForceKill(): Promise<void>;
  openDiagnostics(): Promise<void>;
  dispose(): Promise<void>;
}

export async function startDesktopHarness(options: { uploadDelayMs?: number; quitAnswer?: 'quit' | 'stay' } = {}): Promise<DesktopHarness> {
  const userData = await mkdtemp(join(tmpdir(), 'oi-d2-e2e-'));
  const engine = await startRendererEngine({ uploadDelayMs: options.uploadDelayMs, showInspection: true });
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OI_USER_DATA_DIR = userData;
  environment.OI_RENDERER_ROOT = resolve(DEV_RENDERER);
  environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  if (options.quitAnswer) environment.OI_E2E_QUIT_ANSWER = options.quitAnswer;
  const errors: string[] = [];
  let app = await launch(environment, errors);
  let page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'Choose your server' })).toBeVisible();
  await signIn(page, app, environment, engine, errors);
  await mkdir(TASK16_SCREENSHOT_ROOT, { recursive: true });
  await page.screenshot({ path: join(TASK16_SCREENSHOT_ROOT, 'work-list.png'), animations: 'disabled' });

  const harness: DesktopHarness = {
    get app() { return app; },
    set app(value) { app = value; },
    get page() { return page; },
    set page(value) { page = value; },
    userData,
    engine,
    environment,
    errors,
    async restartGracefully() {
      await app.close().catch(() => undefined);
      app = await launch(environment, errors);
      page = await app.firstWindow();
      await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 20_000 });
    },
    async restartAfterForceKill() {
      const current = app;
      const pid = current.process().pid;
      if (pid === undefined) throw new Error('electron-main-pid-missing');
      await execFileAsync('taskkill.exe', ['/F', '/PID', String(pid)]).catch((error: unknown) => {
        if (!current.process().killed) throw error;
      });
      await current.close().catch(() => undefined);
      app = await launch(environment, errors);
      page = await app.firstWindow();
      try {
        await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 20_000 });
      } catch (error) {
        throw new Error(`desktop restart did not recover; body=${await page.locator('body').innerText()}`, { cause: error });
      }
    },
    async openDiagnostics() {
      await page.getByRole('button', { name: 'Diagnostics (development only)' }).click();
      await page.getByLabel('Inspection id').fill('insp-7');
    },
    async dispose() {
      await app.close().catch(() => undefined);
      await engine.close();
      await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
  return harness;
}

async function launch(environment: Record<string, string>, errors: string[]): Promise<ElectronApplication> {
  const app = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  app.on('console', (message) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });
  app.on('window', (page) => {
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`renderer-console: ${message.text()}`); });
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.name}: ${error.message}`));
    page.on('requestfailed', (request) => errors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`));
  });
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url) => { Reflect.set(globalThis, 'rendererExternalUrl', url); };
  });
  return app;
}

async function signIn(page: Page, app: ElectronApplication, environment: Record<string, string>, engine: RendererEngine, errors: string[]): Promise<void> {
  let stage = 'initial';
  if (await page.getByLabel('Server address').count()) {
    await page.getByLabel('Server address').fill(engine.url);
    stage = 'filled';
    await page.getByRole('button', { name: 'Continue' }).click();
    stage = `continued: ${await page.locator('body').innerText()}`;
    await expect(page.getByRole('heading', { name: 'Connect to this server?' })).toBeVisible();
    await expect(page.getByTestId('canonical-origin')).toHaveText(engine.url);
    await page.getByRole('button', { name: 'Connect' }).click();
    stage = `connected: ${await page.locator('body').innerText()}`;
  }
  try {
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
  } catch (error) {
    throw new Error(`desktop sign-in state did not advance; stage=${stage}; body=${await page.locator('body').innerText()} url=${page.url()} requests=${engine.requests.join(' | ')} errors=${errors.join(' | ')}`, { cause: error });
  }
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect.poll(() => app.evaluate(() => Reflect.get(globalThis, 'rendererExternalUrl'))).toEqual(expect.stringContaining('/oauth/authorize?'));
  const authorizeUrl = String(await app.evaluate(() => Reflect.get(globalThis, 'rendererExternalUrl')));
  const state = new URL(authorizeUrl).searchParams.get('state');
  if (!state) throw new Error('renderer-auth-state-missing');
  const callback = new URL('io.inspectorhub.app:/oauth/callback');
  callback.searchParams.set('code', 'renderer-code');
  callback.searchParams.set('state', state);
  const executable = await app.evaluate(() => process.execPath);
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const child = spawn(executable, ['dist-electron/main/index.cjs', callback.href], { cwd: process.cwd(), env: environment, windowsHide: true, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error('renderer-oauth-callback-failed');
  await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible({ timeout: 20_000 });
}
