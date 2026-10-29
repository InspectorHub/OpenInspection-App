import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let electronApp: ElectronApplication | undefined;
let userData: string;
let rendererRoot: string;
let closeEngine: (() => Promise<void>) | undefined;
let environment: Record<string, string>;
let activeEngine: Awaited<ReturnType<typeof startAuthEngine>> | undefined;

async function jsonBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function startAuthEngine() {
  let origin = '';
  let tokenCalls = 0;
  const server = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', 'https://localhost');
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    const url = new URL(request.url ?? '/', origin);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (request.method === 'POST' && url.pathname === '/oauth/register') {
      void jsonBody(request).then(() => json({ client_id: 'fake-client' }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/client/compat') {
      json({ success: true, data: { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2 } });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      const state = encodeURIComponent(url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: `io.inspectorhub.app:/oauth/callback?code=fake-code&state=${state}` }).end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/oauth/token') {
      void jsonBody(request).then((body) => {
        if (body.code !== 'fake-code') { json({ error: 'invalid_grant' }, 400); return; }
        tokenCalls += 1;
        json({ access_token: 'fake-access-token', refresh_token: 'fake-refresh-token', token_type: 'Bearer' });
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/client/session' && request.headers.authorization === 'Bearer fake-access-token') {
      json({ success: true, data: { userId: 'fake-user', tenantId: 'fake-tenant', role: 'inspector', offlineMaxDays: 30 } });
      return;
    }
    json({ error: 'not-found' }, 404);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('auth-engine-listen-failed');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    get tokenCalls() { return tokenCalls; },
    async callbackFor(state: string): Promise<string> {
      const response = await fetch(`${origin}/oauth/authorize?client_id=fake-client&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
      const location = response.headers.get('location');
      if (response.status !== 302 || !location) throw new Error('fake-authorize-redirect-missing');
      return location;
    },
    close: () => new Promise<void>((resolveClose) => { server.close(() => resolveClose()); server.closeAllConnections(); }),
  };
}

async function startSecondInstance(executable: string, callbackUrl: string): Promise<number | null> {
  const child = spawn(executable, ['dist-electron/main/index.cjs', callbackUrl], {
    cwd: process.cwd(), env: environment, windowsHide: true, stdio: 'ignore',
  });
  const [code] = await once(child, 'exit');
  return code as number | null;
}

test.beforeEach(async () => {
  const engine = await startAuthEngine();
  activeEngine = engine;
  closeEngine = engine.close;
  userData = await mkdtemp(join(tmpdir(), 'oi-signin-data-'));
  rendererRoot = await mkdtemp(join(tmpdir(), 'oi-signin-renderer-'));
  await copyFile(resolve('e2e-electron/fixtures/signin-page/index-electron.html'), join(rendererRoot, 'index-electron.html'));
  await copyFile(resolve('e2e-electron/fixtures/signin-page/signin.js'), join(rendererRoot, 'signin.js'));
  await writeFile(join(rendererRoot, 'auth-config.js'), `window.authEngine = ${JSON.stringify(engine.origin)};\n`);
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OI_USER_DATA_DIR = userData;
  environment.OI_RENDERER_ROOT = rendererRoot;
  environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
});

test.afterEach(async () => {
  await electronApp?.close();
  await closeEngine?.();
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(rendererRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  activeEngine = undefined;
});

test('system-browser sign-in ignores a wrong state and accepts the matching single-instance callback', async () => {
  if (!electronApp) throw new Error('electron-app-not-started');
  const page = await electronApp.firstWindow();
  await expect(page.locator('#status')).toHaveText('Ready');
  await electronApp.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#state')).not.toHaveText('No sign-in started');
  await expect(page.locator('#status')).toHaveText('Waiting for sign-in');
  const state = await page.locator('#state').textContent();
  if (!state) throw new Error('oauth-state-missing');
  const engine = await startAuthEngineHandleForExistingPage();
  const callback = await engine.callbackFor(state);
  const wrong = new URL(callback);
  wrong.searchParams.set('state', 'wrong-state');
  const executable = await electronApp.evaluate(() => process.execPath);
  expect(await startSecondInstance(executable, wrong.href)).toBe(0);
  await expect(page.locator('#status')).toHaveText('Waiting for sign-in');
  expect(engine.tokenCalls).toBe(0);
  expect(await startSecondInstance(executable, callback)).toBe(0);
  await expect(page.locator('#status')).toHaveText('Signed in: fake-user');
  expect(engine.tokenCalls).toBe(1);
  const log = await readFile(join(userData, 'logs', 'main.log'), 'utf8');
  expect(log).not.toContain('code=');
  expect(log).not.toContain('fake-code');
});

async function startAuthEngineHandleForExistingPage() {
  if (!activeEngine) throw new Error('fake-engine-not-started');
  return activeEngine;
}
