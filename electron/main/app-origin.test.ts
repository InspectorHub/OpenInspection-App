import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN, createAppOriginHandler, createHttpsPassthrough, isAppOrigin, mapRendererPath } from './app-origin.ts';

describe('renderer path boundary', () => {
  const root = resolve('renderer');
  it('maps only explicit local resources under the renderer root', () => {
    expect(mapRendererPath(root, '/')).toBe(resolve(root, 'index-electron.html'));
    expect(mapRendererPath(root, '/assets/app.js')).toBe(resolve(root, 'assets/app.js'));
    expect(mapRendererPath(root, '/icons/My%20Icon.svg')).toBe(resolve(root, 'icons/My Icon.svg'));
  });
  it.each(['/../x', '/%2e%2e/x', '/a/../x', '/a\\x', '/\\\\?\\C:\\x', '//server/share', '/C:/x', '/a.js:stream', '/%00x', '/%252e%252e/x', '/a%2fx', '/a%5cx', '/%zz', '/./x', '/..%20/x', '/a./x', '/NUL', '/con.txt', '/a|b'])('rejects raw path %s', (path) => {
    expect(mapRendererPath(root, path)).toBeNull();
  });
});

describe('local origin handler', () => {
  const root = resolve('renderer');
  function setup() {
    const readFile = vi.fn(async () => new TextEncoder().encode('content'));
    const remote = new Response('remote', { status: 206, headers: { 'Content-Range': 'bytes 0-5/9' } });
    const passthrough = vi.fn(async () => remote);
    return { readFile, passthrough, remote, handler: createAppOriginHandler({ rendererRoot: root, readFile, passthrough, packaged: true }) };
  }
  it('serves the entry and resources with MIME, CSP and nosniff', async () => {
    const { handler, readFile } = setup();
    for (const [path, type] of [['/', 'text/html; charset=utf-8'], ['/app.js', 'text/javascript; charset=utf-8'], ['/worker.mjs', 'text/javascript; charset=utf-8'], ['/style.css', 'text/css; charset=utf-8']]) {
      const response = await handler(new Request(APP_ORIGIN + path));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(readFile.mock.calls[0]).toEqual([resolve(root, 'index-electron.html')]);
    expect(readFile.mock.calls[1]).toEqual([resolve(root, 'app.js')]);
  });
  it.each(['/%2e%2e%5cx', '/a%2fb', '/%255csecret', '/a:stream', '/%00x'])('rejects retained encoded path %s without reading', async (path) => {
    const { handler, readFile } = setup();
    expect((await handler(new Request(APP_ORIGIN + path))).status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });
  it('handles HEAD, denies local writes without reads, and never falls back for missing scripts', async () => {
    const { handler, readFile } = setup();
    expect(await (await handler(new Request(APP_ORIGIN, { method: 'HEAD' }))).text()).toBe('');
    readFile.mockClear();
    expect((await handler(new Request(APP_ORIGIN, { method: 'POST' }))).status).toBe(405);
    expect(readFile).not.toHaveBeenCalled();
    readFile.mockRejectedValueOnce(new Error('SECRET_PATH'));
    const response = await handler(new Request(APP_ORIGIN + '/missing.js'));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('SECRET_PATH');
    expect(readFile).toHaveBeenCalledTimes(1);
  });
  it.each(['https://localhost.evil/', 'https://localhost@evil.example/', 'https://localhost:8443/', 'https://example.com/'])('passes remote requests and responses unchanged: %s', async (url) => {
    const { handler, readFile, passthrough, remote } = setup();
    const request = new Request('https://example.com', { method: 'POST', body: 'original', headers: { Range: 'bytes=0-5' } });
    // Fetch rejects credentials before dispatch. Retain the raw URL here to exercise our boundary too.
    Object.defineProperty(request, 'url', { value: url });
    expect(await handler(request)).toBe(remote);
    expect(passthrough).toHaveBeenCalledExactlyOnceWith(request);
    expect(readFile).not.toHaveBeenCalled();
  });
  it('bypasses the protocol handler exactly once, retaining the streaming response', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([7])); controller.close(); } }), { status: 206 });
    const fetch = vi.fn(async () => response);
    const request = new Request('https://example.com', { headers: { Range: 'bytes=0-0' } });
    expect(await createHttpsPassthrough({ fetch })(request)).toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request, { bypassCustomProtocolHandlers: true });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([7]));
  });
  it('contains a remote failure without leaking its error', async () => {
    const handler = createAppOriginHandler({ rendererRoot: root, packaged: false, readFile: vi.fn(), passthrough: async () => { throw new Error('SECRET'); } });
    const response = await handler(new Request('https://example.com'));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('SECRET');
  });
  it('requires the exact HTTPS origin without credentials or blob wrappers', () => {
    expect(isAppOrigin(APP_ORIGIN + '/valid')).toBe(true);
    for (const url of ['https://localhost.evil', 'https://localhost:8443', 'https://user@localhost', 'blob:https://localhost/x', 'broken']) expect(isAppOrigin(url)).toBe(false);
  });
});
