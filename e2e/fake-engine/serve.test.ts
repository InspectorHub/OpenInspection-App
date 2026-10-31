import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const serve = fileURLToPath(new URL('./serve.mjs', import.meta.url));
let child: ChildProcess | undefined;
let stderrText = '';

async function start(args: string[] = []): Promise<{ origin: string; control: string }> {
  child = spawn(process.execPath, [serve, '--port', '0', '--host', '127.0.0.1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  stderrText = '';
  child.stderr!.on('data', (chunk) => { stderrText += String(chunk); });
  let text = '';
  for await (const chunk of child.stdout!) {
    text += String(chunk);
    if (text.includes('\n')) break;
  }
  if (!text.includes('\n')) {
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit');
    throw new Error(`fake engine failed to start (exit ${String(child.exitCode)}): ${stderrText}`);
  }
  expect(text.trim().split('\n')).toHaveLength(1);
  return JSON.parse(text) as { origin: string; control: string };
}

async function stop(): Promise<void> {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  child = undefined;
}

function post(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** fetch cannot set Host, and a browser-like Origin must be sent as is, so these go through node:http. */
function raw(url: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(body);
  });
}

function multipart(bytes: string): { body: string; type: string } {
  return { type: 'multipart/form-data; boundary=BND', body: `--BND\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n${bytes}\r\n--BND--\r\n` };
}

afterEach(stop);

describe('standalone fake engine', () => {
  it('prints one JSON line with the origin and serves the seeded inspection', async () => {
    const { origin } = await start();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(`${origin}/api/inspections/insp-7`);
    const body = (await response.json()) as { data: { inspection: { id: string } } };
    expect(body.data.inspection.id).toBe('insp-7');
  });

  it('the inspection scenario makes insp-7 visible, the default does not', async () => {
    const visible = async (origin: string) => {
      const response = await post(`${origin}/api/client/inspections/visible`, { ids: ['insp-7'] });
      return ((await response.json()) as { data: { visible: string[] } }).data.visible;
    };
    expect(await visible((await start()).origin)).toEqual([]);
    await stop();
    expect(await visible((await start(['--scenario', 'inspection'])).origin)).toEqual(['insp-7']);
  });

  it('fault injection toggles through the control port, which stays reachable while unavailable', async () => {
    const { origin, control } = await start();
    expect((await fetch(`${origin}/api/client/compat`)).status).toBe(200);
    expect((await post(`${control}/__test__/unavailable`, { value: true })).status).toBe(200);
    await expect(fetch(`${origin}/api/client/compat`)).rejects.toThrow();
    expect((await fetch(`${control}/__test__/state`)).status).toBe(200);
    expect((await post(`${control}/__test__/unavailable`, { value: false })).status).toBe(200);
    expect((await fetch(`${origin}/api/client/compat`)).status).toBe(200);
  });

  it('delay and compatibility are adjustable, and the engine port exposes no test routes', async () => {
    const { origin, control } = await start();
    expect((await fetch(`${origin}/__test__/state`)).status).toBe(404);
    expect((await post(`${control}/__test__/upload-delay`, { ms: 5 })).status).toBe(200);
    expect((await post(`${control}/__test__/compatibility`, { minSupported: '9.0.0' })).status).toBe(200);
    const compat = (await (await fetch(`${origin}/api/client/compat`)).json()) as { data: { minSupported: string } };
    expect(compat.data.minSupported).toBe('9.0.0');
    expect((await post(`${control}/__test__/upload-delay`, { ms: 'x' })).status).toBe(404);
  });

  it.skipIf(process.platform === 'win32')('shuts down gracefully on SIGTERM with exit code 0 (POSIX only: a Windows kill is a forced terminate)', async () => {
    const { origin } = await start();
    const exited = once(child!, 'exit');
    child!.kill('SIGTERM');
    const [code] = (await exited) as [number | null];
    expect(code).toBe(0);
    await expect(fetch(`${origin}/api/client/compat`)).rejects.toThrow();
  });

  it('closes its ports when the process ends (any platform)', async () => {
    const { origin } = await start();
    await stop();
    await expect(fetch(`${origin}/api/client/compat`)).rejects.toThrow();
  });

  it('control port rejects a foreign Host, any Origin and non-JSON writes, and accepts a direct client', async () => {
    const { control } = await start();
    const port = new URL(control).port;
    expect(await raw(`${control}/__test__/state`, {})).toBe(200);
    expect(await raw(`${control}/__test__/state`, { host: `localhost:${port}` })).toBe(200);
    expect(await raw(`${control}/__test__/state`, { host: `evil.example:${port}` })).toBe(403);
    expect(await raw(`${control}/__test__/state`, { host: '127.0.0.1:1' })).toBe(403);
    expect(await raw(`${control}/__test__/state`, { origin: 'https://evil.example' })).toBe(403);
    const json = JSON.stringify({ value: true });
    expect(await raw(`${control}/__test__/unavailable`, { 'content-type': 'text/plain' }, 'POST', json)).toBe(415);
    expect(await raw(`${control}/__test__/unavailable`, { 'content-type': 'application/json', origin: 'https://evil.example' }, 'POST', json)).toBe(403);
    expect(await raw(`${control}/__test__/unavailable`, { 'content-type': 'application/json' }, 'POST', JSON.stringify({ value: false }))).toBe(200);
  });

  it('brackets an IPv6 host in the printed origin and maps :: to ::1', async () => {
    const { origin } = await start(['--host', '::1']);
    expect(origin).toMatch(/^http:\/\/\[::1\]:\d+$/);
    expect((await fetch(`${origin}/api/client/compat`)).status).toBe(200);
    await stop();
    expect((await start(['--host', '::'])).origin).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it('warns on stderr when bound beyond loopback, not on loopback', async () => {
    await start();
    expect(stderrText).not.toContain('WARNING');
    await stop();
    await start(['--host', '0.0.0.0']);
    await vi.waitFor(() => expect(stderrText).toContain('WARNING'));
  });

  it('echoes only allow-listed origins in CORS and always varies on Origin', async () => {
    const { origin } = await start();
    for (const allowed of ['https://localhost', 'capacitor://localhost', 'http://localhost']) {
      const response = await fetch(`${origin}/api/client/compat`, { headers: { origin: allowed } });
      expect(response.headers.get('access-control-allow-origin')).toBe(allowed);
      expect(response.headers.get('vary')).toBe('Origin');
    }
    const foreign = await fetch(`${origin}/api/client/compat`, { headers: { origin: 'https://evil.example' } });
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    expect(foreign.headers.get('vary')).toBe('Origin');
  });

  it('upload path: 411 without length, 400 without a file part, 201 with one, delay applies, completedCounts counts it', async () => {
    const { origin, control } = await start();
    const response = await post(`${origin}/api/inspections/insp-7/media/upload-url`, { pendingId: 'p1', contentType: 'image/jpeg' });
    const slot = ((await response.json()) as { data: { url: string; key: string } }).data;
    expect(slot.url.startsWith(`${origin}/`)).toBe(true);
    const { type, body } = multipart('JPEGBYTES');
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } });
    const chunked = await fetch(slot.url, { method: 'POST', headers: { 'content-type': type }, body: stream, duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(411);
    expect((await fetch(slot.url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'nope' })).status).toBe(400);
    expect((await post(`${control}/__test__/upload-delay`, { ms: 300 })).status).toBe(200);
    const started = Date.now();
    expect((await fetch(slot.url, { method: 'POST', headers: { 'content-type': type }, body })).status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const state = (await (await fetch(`${control}/__test__/state`)).json()) as { completedCounts: Record<string, number>; uploadKeys: string[] };
    expect(state.completedCounts[slot.key]).toBe(1);
    expect(state.uploadKeys).toContain(slot.key);
    const photo = await fetch(`${origin}/api/inspections/insp-7/photo?key=${encodeURIComponent(slot.key)}`, { headers: { authorization: 'Bearer renderer-access-token' } });
    expect(await photo.text()).toBe('JPEGBYTES');
  });
});
