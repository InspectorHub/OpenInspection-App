import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import { describeEvent, devtoolsSockets, FILE_INPUT_DIAGNOSTIC } from './webview-console.mjs';

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

/**
 * The script the recorder runs inside the page. It is run here in a stand-in page (a plain object with the few globals it touches), so
 * what is checked is that it times the two browser calls, notes visibility and uncaught errors, and otherwise changes nothing: the
 * wrappers hand back exactly what the originals do and pass on the arguments they were given.
 */
describe('the page diagnostic, run in a stand-in page', () => {
  interface Page {
    ctx: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- a stand-in for the browser's global object
    logs: string[];
    listeners: Map<string, Array<(event: unknown) => void>>;
    toBlobCalls: unknown[][];
  }

  function standInPage(options: { bitmap?: (...args: unknown[]) => unknown; withBitmap?: boolean } = {}): Page {
    const logs: string[] = [];
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const toBlobCalls: unknown[][] = [];
    const add = (type: string, listener: (event: unknown) => void): void => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    };
    class Input {
      type = 'file';
      files: Array<{ type: string; size: number }> = [];
    }
    class Canvas {
      width = 640;
      height = 480;
      toBlob(callback: unknown, ...rest: unknown[]): string {
        toBlobCalls.push([callback, ...rest]);
        if (typeof callback === 'function') callback({ size: 18516 });
        return 'original-return';
      }
    }
    const ctx: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any -- the stand-in page
      console: { info: (...parts: unknown[]) => logs.push(parts.join(' ')) },
      document: { visibilityState: 'visible', addEventListener: add },
      performance: { now: () => 1000 },
      HTMLInputElement: Input,
      HTMLCanvasElement: Canvas,
      addEventListener: add,
      JSON, Math, Array, String,
    };
    if (options.withBitmap !== false) ctx.createImageBitmap = options.bitmap ?? (() => Promise.resolve({ width: 640, height: 480 }));
    ctx.window = ctx;
    createContext(ctx);
    expect(runInContext(FILE_INPUT_DIAGNOSTIC, ctx)).toBe(true);
    return { ctx, logs, listeners, toBlobCalls };
  }

  it('still reports what a file input handed over (the line the earlier flows read)', () => {
    const page = standInPage();
    const input = new page.ctx.HTMLInputElement();
    input.files = [{ type: 'image/jpeg', size: 17920 }];
    page.listeners.get('change')?.[0]?.({ target: input });
    expect(page.logs).toContain('[file-input-change] [{"type":"image/jpeg","size":17920}]');
  });

  it('times createImageBitmap, passes on its arguments and hands back what it resolved with', async () => {
    const seen: unknown[][] = [];
    const bitmap = { width: 640, height: 480 };
    const page = standInPage({ bitmap: (...args) => { seen.push(args); return Promise.resolve(bitmap); } });
    const file = { name: 'roof-photo.jpg' };
    const result = await page.ctx.createImageBitmap(file, { imageOrientation: 'from-image' });
    await Promise.resolve();
    expect(result).toBe(bitmap);
    expect(seen).toEqual([[file, { imageOrientation: 'from-image' }]]);
    expect(page.logs).toContain('[photo-trace] createImageBitmap start visible');
    expect(page.logs).toContain('[photo-trace] createImageBitmap resolved after 0 ms 640x480');
  });

  it('reports a createImageBitmap that rejects, and the caller still sees the same rejection', async () => {
    const boom = new Error('boom');
    const page = standInPage({ bitmap: () => Promise.reject(boom) });
    await expect(page.ctx.createImageBitmap({})).rejects.toBe(boom);
    await Promise.resolve();
    expect(page.logs).toContain('[photo-trace] createImageBitmap rejected after 0 ms Error: boom');
  });

  it('a createImageBitmap that never settles leaves a start line and no end line (the case it exists to expose)', async () => {
    const page = standInPage({ bitmap: () => new Promise(() => {}) });
    void page.ctx.createImageBitmap({});
    await Promise.resolve();
    expect(page.logs.filter((line) => line.startsWith('[photo-trace] createImageBitmap'))).toEqual(['[photo-trace] createImageBitmap start visible']);
  });

  it('does nothing to a page that has no createImageBitmap', () => {
    const page = standInPage({ withBitmap: false });
    expect(page.ctx.createImageBitmap).toBeUndefined();
  });

  it('times canvas.toBlob, hands the blob to the caller\'s callback and passes on the other arguments', () => {
    const page = standInPage();
    const canvas = new page.ctx.HTMLCanvasElement();
    const received: unknown[] = [];
    const returned = canvas.toBlob((blob: unknown) => received.push(blob), 'image/jpeg', 0.8);
    expect(returned).toBe('original-return');
    expect(received).toEqual([{ size: 18516 }]);
    expect(page.toBlobCalls[0]?.slice(1)).toEqual(['image/jpeg', 0.8]);
    expect(page.logs).toContain('[photo-trace] toBlob start 640x480 visible');
    expect(page.logs).toContain('[photo-trace] toBlob called back after 0 ms 18516 bytes');
  });

  it('leaves a toBlob call alone when its first argument is not a function', () => {
    const page = standInPage();
    const canvas = new page.ctx.HTMLCanvasElement();
    expect(canvas.toBlob('not a function', 'image/png')).toBe('original-return');
    expect(page.toBlobCalls).toEqual([['not a function', 'image/png']]);
    expect(page.logs.some((line) => line.startsWith('[photo-trace] toBlob'))).toBe(false);
  });

  it('notes when the page is hidden, and the errors nobody caught', () => {
    const page = standInPage();
    page.ctx.document.visibilityState = 'hidden';
    page.listeners.get('visibilitychange')?.[0]?.({});
    page.listeners.get('unhandledrejection')?.[0]?.({ reason: 'no decoder' });
    page.listeners.get('error')?.[0]?.({ message: 'script error' });
    expect(page.logs).toEqual(expect.arrayContaining([
      '[photo-trace] visibility hidden',
      '[photo-trace] unhandledrejection no decoder',
      '[photo-trace] window error script error',
    ]));
  });
});
