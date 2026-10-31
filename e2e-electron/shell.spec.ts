import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { APP_ORIGIN, buildCsp } from '../electron/main/app-origin.ts';
import { BRIDGE_METHODS } from '../electron/shared/ipc-contract.ts';

let electronApp: ElectronApplication;
let page: Page;
let directory: string;
let environment: Record<string, string>;

test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oi-shell-'));
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.OI_USER_DATA_DIR = directory;
  environment.OI_RENDERER_ROOT = 'e2e-electron/fixtures/shell-page';
  environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
  page = await electronApp.firstWindow();
  await expect(page.locator('#status')).toHaveText('Shell checks complete');
  // Keep browser launching observable and local to this test process.
  await electronApp.evaluate(({ shell }) => { shell.openExternal = async () => {}; });
});

test.afterEach(async () => {
  await electronApp?.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('isolated fixed-origin shell, strict headers and navigation guards', async () => {
  expect(page.url()).toBe(APP_ORIGIN + '/');
  const globals = await page.evaluate(() => ({ require: typeof Reflect.get(window, 'require'), process: typeof Reflect.get(window, 'process'), keys: Object.keys(Reflect.get(window, 'oiDesktop')) }));
  expect(globals).toEqual({ require: 'undefined', process: 'undefined', keys: ['apiVersion', ...Object.keys(BRIDGE_METHODS)] });
  for (const path of ['/', '/shell.js', '/worker.js']) {
    const headers = await page.evaluate(async (path) => { const response = await fetch(path); return { csp: response.headers.get('content-security-policy'), nosniff: response.headers.get('x-content-type-options') }; }, path);
    expect(headers).toEqual({ csp: buildCsp({ packaged: false }), nosniff: 'nosniff' });
  }
  expect(await page.evaluate(() => new Promise((resolve, reject) => {
    const worker = new Worker('/worker.js');
    worker.onmessage = ({ data }) => { worker.terminate(); resolve(data); };
    worker.onerror = reject;
  }))).toBe('worker-ready');
  await page.screenshot({ path: '.superpowers/sdd/plan-d2-windows-electron/task-4-shell.png' });
  await page.goto('https://example.com').catch(() => {});
  expect(page.url()).toBe(APP_ORIGIN + '/');
  await page.evaluate(() => window.open('https://example.com'));
  await electronApp.evaluate(() => Promise.resolve());
  expect(electronApp.windows()).toHaveLength(1);
  expect(page.url()).toBe(APP_ORIGIN + '/');
});

test('second instance exits and restores and focuses the first window', async () => {
  await electronApp.evaluate(({ app }) => { app.once('second-instance', () => { Reflect.set(globalThis, 'secondObserved', true); }); });
  await electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.minimize(); });
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMinimized())).toBe(true);
  // On Windows Playwright's process handle belongs to cmd.exe, so use the runtime executable.
  const executable = await electronApp.evaluate(() => process.execPath);
  const child = spawn(executable, ['dist-electron/main/index.cjs', 'javascript:untrusted'], { cwd: process.cwd(), env: environment, stdio: 'ignore' });
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    return { count: windows.length, minimized: windows[0]?.isMinimized(), focused: windows[0]?.isFocused(), second: Reflect.get(globalThis, 'secondObserved') === true };
  })).toEqual({ count: 1, minimized: false, focused: true, second: true });
  expect(page.url()).toBe(APP_ORIGIN + '/');
});

test('loopback WebSocket, HTTPS Range and streamed response survive protocol interception', async () => {
  const http = createHttpServer();
  http.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    const payload = Buffer.from('loopback-ready');
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    socket.on('data', () => { socket.end(); });
  });
  const cert = await readFile(resolve('e2e-electron/fixtures/loopback-cert.pem'));
  const key = await readFile(resolve('e2e-electron/fixtures/loopback-key.pem'));
  let releaseStream = (): void => {};
  const https = createHttpsServer({ cert, key }, (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
    response.setHeader('Access-Control-Expose-Headers', 'Content-Range');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.url === '/range') {
      if (request.headers.range !== 'bytes=2-5') { response.writeHead(400); response.end(); return; }
      response.writeHead(206, { 'Content-Type': 'text/plain', 'Content-Range': 'bytes 2-5/10' });
      response.end('2345');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.write('first-');
      releaseStream = () => { response.end('second'); };
    }
  });
  http.listen(0, '127.0.0.1');
  https.listen(0, '127.0.0.1');
  await Promise.all([once(http, 'listening'), once(https, 'listening')]);
  try {
    const httpAddress = http.address();
    const httpsAddress = https.address();
    if (!httpAddress || typeof httpAddress === 'string' || !httpsAddress || typeof httpsAddress === 'string') throw new Error('Missing loopback address');
    await electronApp.evaluate(({ session }) => {
      session.defaultSession.setCertificateVerifyProc(({ hostname }, callback) => callback(hostname === '127.0.0.1' ? 0 : -3));
    });
    const socketResult = await page.evaluate((port) => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      socket.onmessage = ({ data }) => { socket.close(); resolve(data); };
      socket.onerror = reject;
    }), httpAddress.port);
    expect(socketResult).toBe('loopback-ready');
    const range = await page.evaluate(async (port) => {
      const response = await fetch(`https://127.0.0.1:${port}/range`, { headers: { Range: 'bytes=2-5' } });
      return { status: response.status, range: response.headers.get('content-range'), text: await response.text() };
    }, httpsAddress.port);
    expect(range).toEqual({ status: 206, range: 'bytes 2-5/10', text: '2345' });
    let signalChunk = (_value: string): void => {};
    const firstChunk = new Promise<string>((resolve) => { signalChunk = resolve; });
    await page.exposeFunction('receivedStreamChunk', signalChunk);
    const streamResult = page.evaluate(async (port) => {
      const response = await fetch(`https://127.0.0.1:${port}/stream`);
      const reader = response.body!.getReader();
      const first = await reader.read();
      const initial = new TextDecoder().decode(first.value);
      await Reflect.get(window, 'receivedStreamChunk')(initial);
      let text = initial;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
      return text;
    }, httpsAddress.port);
    expect(await firstChunk).toBe('first-');
    releaseStream();
    expect(await streamResult).toBe('first-second');
  } finally {
    releaseStream();
    http.closeAllConnections();
    https.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => http.close(() => resolve())), new Promise<void>((resolve) => https.close(() => resolve()))]);
  }
});
