import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { describeEvent, devtoolsSockets } from './webview-console.mjs';

/**
 * The recorder writes what a failed golden flow's page printed. Its two pure parts are tested here: which socket is a WebView's, and how a
 * protocol event becomes a line. Whether it connects to a real WebView was seen on a real phone (see the PROGRESS entry), not here.
 */
describe('devtoolsSockets', () => {
  const proc = [
    'Num RefCount Protocol Flags Type St Inode Path',
    '0000000000000000: 00000002 00000000 00010000 0001 01 12345 @webview_devtools_remote_6792',
    '0000000000000000: 00000002 00000000 00010000 0001 01 12346 /dev/socket/zygote',
    '0000000000000000: 00000002 00000000 00010000 0001 01 12347 @chrome_devtools_remote',
    '0000000000000000: 00000002 00000000 00010000 0001 01 12348 @webview_devtools_remote_7011',
    '0000000000000000: 00000002 00000000 00010000 0001 01 12349 @webview_devtools_remote_7011',
  ].join('\n');

  it('lists the WebView sockets once each, in the order they appear, and ignores every other socket', () => {
    expect(devtoolsSockets(proc)).toEqual(['webview_devtools_remote_6792', 'webview_devtools_remote_7011']);
  });

  it.each([[''], ['no sockets here'], ['@webview_devtools_remote_']])('finds nothing in %j (an empty answer is "none", never an invented socket)', (text) => {
    expect(devtoolsSockets(text)).toEqual([]);
  });
});

describe('describeEvent', () => {
  const at = Date.UTC(2026, 10, 2, 14, 15, 0);

  it('a console call becomes one line with its level and the text of its arguments', () => {
    const line = describeEvent({ method: 'Runtime.consoleAPICalled', params: { type: 'error', args: [{ type: 'string', value: 'import failed' }, { type: 'number', value: 3 }, { type: 'object', description: 'Error: x' }] } }, at);
    expect(line).toEqual({ at: '2026-11-02T14:15:00.000Z', kind: 'console', level: 'error', text: 'import failed 3 Error: x' });
  });

  it('an uncaught exception keeps its description and where it came from', () => {
    const line = describeEvent({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught', url: 'http://localhost:5173/src/a.tsx', lineNumber: 12, exception: { description: 'TypeError: boom' } } } }, at);
    expect(line).toMatchObject({ kind: 'exception', level: 'error' });
    expect(line?.text).toContain('TypeError: boom');
    expect(line?.text).toContain('a.tsx');
  });

  it('a browser log entry (a blocked request, a failed load) is kept with its level and url', () => {
    const line = describeEvent({ method: 'Log.entryAdded', params: { entry: { level: 'error', text: 'Failed to load resource', url: 'http://localhost:8792/x' } } }, at);
    expect(line).toMatchObject({ kind: 'log', level: 'error' });
    expect(line?.text).toBe('Failed to load resource http://localhost:8792/x');
  });

  it('every other event is dropped, and an empty message does not throw', () => {
    expect(describeEvent({ method: 'Page.frameNavigated', params: {} }, at)).toBeNull();
    expect(describeEvent({}, at)).toBeNull();
  });
});

/**
 * What the recorder must never do: hold the job. The first case has no app at all; the second has an app whose DevTools port accepts the
 * connection and then never answers (a WebView that is being killed does this), which used to leave the recorder waiting for a reply with
 * the stop signal unable to reach it.
 */
describe('collect, as a process (a fake adb stands in for the device)', () => {
  const SCRIPT = join(__dirname, 'webview-console.mjs');
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  afterAll(() => {
    for (const child of children) child.kill('SIGKILL');
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function fakeAdb(dir: string, port: number | null): string {
    const file = join(dir, 'fake-adb.mjs');
    const answers =
      port === null
        ? "process.stdout.write('');"
        : `const a = process.argv.slice(2).join(' ');
if (a.startsWith('shell cat')) process.stdout.write('0: 1 0 0 1 1 1 @webview_devtools_remote_42\\n');
else if (a.startsWith('shell pidof')) process.stdout.write('42\\n');
else if (a.startsWith('forward tcp:0')) process.stdout.write('${String(port)}\\n');`;
    writeFileSync(file, answers);
    return file;
  }

  function start(dir: string, adbScript: string, out: string): ChildProcess {
    const child = spawn(process.execPath, [SCRIPT, 'collect', out], { env: { ...process.env, WEBVIEW_CONSOLE_ADB: adbScript }, stdio: 'ignore' });
    children.push(child);
    return child;
  }

  const exitsWithin = (child: ChildProcess, ms: number): Promise<boolean> =>
    new Promise((resolve) => {
      if (child.exitCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });

  it('with no app on the device it keeps looking, writes "started", and stops promptly when told to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webview-console-'));
    dirs.push(dir);
    const out = join(dir, 'out.jsonl');
    const child = start(dir, fakeAdb(dir, null), out);
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull(); // control: it did not give up by itself
    expect(readFileSync(out, 'utf8')).toContain('"text":"started"');
    child.kill('SIGTERM');
    expect(await exitsWithin(child, 5000)).toBe(true);
  }, 15000);

  it('with a DevTools port that accepts the connection and never answers, it still stops when told to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webview-console-'));
    dirs.push(dir);
    const sockets: Socket[] = [];
    // One port for both the /json listing and the "WebSocket": the listing answers, the upgrade request never does.
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${String((server.address() as { port: number }).port)}/devtools/page/1` }]));
      void request;
    });
    // The recorder is killed while this connection is open: the reset that follows is the point of the test, not a failure.
    server.on('upgrade', (_request, socket) => { socket.on('error', () => undefined); sockets.push(socket); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const out = join(dir, 'out.jsonl');
    const child = start(dir, fakeAdb(dir, port), out);
    await new Promise((r) => setTimeout(r, 2500));
    expect(child.exitCode).toBeNull();
    // Control: the recorder really got as far as asking for the WebSocket that never answers (otherwise this tests nothing).
    expect(sockets.length).toBeGreaterThan(0);
    child.kill('SIGTERM');
    const stopped = await exitsWithin(child, 5000);
    for (const socket of sockets) socket.destroy();
    server.close();
    expect(stopped).toBe(true);
  }, 20000);
});
