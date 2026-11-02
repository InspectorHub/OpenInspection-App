import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUploaderHost, createMediaFileResolver, type UploadTransport } from './uploader-host.ts';
import type { UploaderStartOptions } from '../../shared/ipc-contract.ts';
import { MAX_MEDIA_BYTES } from '../../../src/media/media-types.ts';

const uploadIds = vi.hoisted(() => ({ next: 0, last: '' }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomUUID: () => { uploadIds.last = `test-upload-${++uploadIds.next}`; return uploadIds.last; } };
});

describe('createUploaderHost validation and lifecycle', () => {
  let root: string;
  let media: string;
  let cache: string;
  let file: string;
  let timers: { setTimeout: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>; clearTimeout: (id: ReturnType<typeof setTimeout>) => void };
  let transport: UploadTransport;
  let host: ReturnType<typeof createUploaderHost>;
  const base = (): UploaderStartOptions => ({ filePath: pathToFileURL(file).href, serverUrl: 'https://engine.example', method: 'POST', uploadType: 'multipart', fileField: 'file', mimeType: 'image/jpeg', maxRetries: 0, headers: { 'x-client-platform': 'windows', 'x-client-version': '1.0.0' }, notificationTitle: 'Uploading photos' });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oi-uploader-'));
    media = join(root, 'media'); cache = join(root, 'cache');
    await mkdir(media); await mkdir(cache);
    file = join(media, 'photo.jpg'); await writeFile(file, Buffer.from([0xff, 0xd8, 0xff]));
    timers = { setTimeout: (cb, ms) => setTimeout(cb, ms), clearTimeout: (id) => clearTimeout(id) };
    transport = { send: vi.fn(async () => ({ statusCode: 200 })) };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers, random: () => 0, packaged: true });
  });
  afterEach(async () => { host?.abortAll('quit'); await rm(root, { recursive: true, force: true }); });

  it.each([
    ['http in a packaged build', { serverUrl: 'http://engine.example' }],
    ['URL credentials', { serverUrl: 'https://user:pass@engine.example' }],
    ['control characters', { serverUrl: 'https://engine.example\n' }],
    ['unsupported schemes', { serverUrl: 'file:///tmp/x' }],
    ['unknown headers', { headers: { 'x-client-platform': 'windows', authorization: 'secret' } }],
    ['ambiguous header casing', { headers: { 'x-client-platform': 'windows', 'X-Client-Platform': 'windows' } }],
    ['forbidden headers', { headers: { 'x-client-platform': 'windows', 'content-length': '3' } }],
    ['invalid client version', { headers: { 'x-client-platform': 'windows', 'x-client-version': 'bad version' } }],
    ['invalid platform', { headers: { 'x-client-platform': 'android' } }],
    ['invalid multipart field', { fileField: 'field with space' }],
    ['unsupported media type', { mimeType: 'application/x-msdownload' }],
    ['fractional retry count', { maxRetries: 1.5 }],
    ['too many retries', { maxRetries: 6 }],
    ['wrong method', { method: 'PUT' }],
    ['wrong upload type', { uploadType: 'raw' }],
    ['oversized notification title', { notificationTitle: 'x'.repeat(257) }],
    ['malformed file uri', { filePath: 'file:///etc/passwd' }],
  ])('rejects %s before transport', async (_label, patch) => {
    await expect(host.start({ ...base(), ...patch } as UploaderStartOptions)).rejects.toBeDefined();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('accepts a Stream destination without client headers and refuses one that carries them', async () => {
    const stream = { ...base(), serverUrl: 'https://upload.videodelivery.net/abcdefgh12345678', mimeType: 'video/mp4', headers: {} };
    file = join(media, 'clip.mp4'); await writeFile(file, Buffer.from([0, 0, 0, 24]));
    const started = await host.start({ ...stream, filePath: pathToFileURL(file).href });
    expect(started.id).toBeTruthy();
    await vi.waitFor(() => expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ headers: {} })));
    await expect(host.start({ ...stream, filePath: pathToFileURL(file).href, headers: { 'x-client-platform': 'windows' } })).rejects.toBeDefined();
    await expect(host.start({ ...base(), headers: {} })).rejects.toBeDefined();
  });

  it('allows HTTP only in unpackaged development', async () => {
    transport = { send: vi.fn(async () => ({ statusCode: 200 })) };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers, random: () => 0, packaged: false });
    const started = await host.start({ ...base(), serverUrl: 'http://localhost:8787' });
    expect(started.id).toBeTruthy();
    host.abortAll('quit');
  });

  it('resolves only regular files whose real path remains inside mediaRoot', async () => {
    const resolveFile = createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache });
    await expect(resolveFile(pathToFileURL(file).href)).resolves.toMatchObject({ size: 3 });
    await expect(resolveFile(pathToFileURL(join(cache, 'x.jpg')).href)).rejects.toBeDefined();
    await expect(resolveFile('file:///C:/outside.jpg')).rejects.toBeDefined();
    const outside = join(root, 'outside'); await mkdir(outside);
    const outsideFile = join(outside, 'escape.jpg'); await writeFile(outsideFile, Buffer.from([1, 2, 3]));
    const link = join(media, 'escape'); await symlink(outside, link, 'junction');
    await expect(resolveFile(pathToFileURL(join(link, 'escape.jpg')).href)).rejects.toBeDefined();
  });

  it('rejects a photo over the 10 MiB engine ceiling before transport', async () => {
    const oversized = createUploaderHost({ transport, resolveMediaFile: async () => ({ path: file, size: MAX_MEDIA_BYTES + 1 }), timers, random: () => 0, packaged: true });
    await expect(oversized.start(base())).rejects.toBeDefined();
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('retries transport resets with bounded backoff but does not retry HTTP 503', async () => {
    const delays: number[] = [];
    const retryTimers = { setTimeout: ((cb: () => void, ms: number) => { if (ms <= 4000) delays.push(ms); return setTimeout(ms <= 4000 ? cb : () => undefined, 0); }) as typeof timers.setTimeout, clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) };
    const flaky: UploadTransport = { send: vi.fn().mockRejectedValueOnce(Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })).mockResolvedValueOnce({ statusCode: 201 }) };
    host = createUploaderHost({ transport: flaky, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers: retryTimers, random: () => 0, packaged: true });
    const events: Array<{ name: string; payload?: { statusCode?: number } }> = [];
    host.onEvent((event) => events.push(event));
    const task = await host.start({ ...base(), maxRetries: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.some((event) => event.name === 'completed')).toBe(true);
    expect(flaky.send).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([1000]);
    expect(events.filter((event) => event.name === 'completed')).toHaveLength(1);
    await host.remove(task.id);
  });

  it('emits a 503 completion exactly once without retrying', async () => {
    transport = { send: vi.fn(async () => ({ statusCode: 503 })) };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers, random: () => 0, packaged: true });
    const events: Array<{ name: string; payload?: { statusCode?: number } }> = [];
    host.onEvent((event) => events.push(event));
    const task = await host.start({ ...base(), maxRetries: 5 });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events).toEqual([{ name: 'completed', id: task.id, payload: { statusCode: 503 } }]);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('caps transient retries at maxRetries and keeps network errors in the fixed event vocabulary', async () => {
    let calls = 0;
    const delays: number[] = [];
    const retryTimers = { setTimeout: ((cb: () => void, ms: number) => { if (ms <= 4000) delays.push(ms); return setTimeout(ms <= 4000 ? cb : () => undefined, 0); }) as typeof timers.setTimeout, clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id) };
    transport = { send: async () => { calls += 1; throw Object.assign(new Error('ECONNRESET /private/path'), { code: 'ECONNRESET' }); } };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers: retryTimers, random: () => 0, packaged: true });
    const events: unknown[] = []; host.onEvent((event) => events.push(event));
    await host.start({ ...base(), maxRetries: 2 });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(calls).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(events[0]).toMatchObject({ name: 'failed', payload: { error: 'network' } });
    expect(JSON.stringify(events)).not.toContain('private');
  });

  it('notifies active counts once on start and once after settlement', async () => {
    transport = { send: async () => ({ statusCode: 201 }) };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers, random: () => 0, packaged: true });
    const counts: number[] = []; host.onActiveCountChange((count) => counts.push(count));
    await host.start(base());
    await vi.waitFor(() => expect(host.activeCount()).toBe(0));
    expect(counts).toEqual([1, 0]);
  });

  it('reports the upload timeout with a fixed timeout code', async () => {
    let timeout: (() => void) | undefined;
    const manual = { setTimeout: (cb: () => void, ms: number) => { if (ms === 600_000) timeout = cb; return { ms }; }, clearTimeout: () => undefined };
    transport = { send: (request) => new Promise((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true }); }) };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers: manual, random: () => 0, packaged: true });
    const events: unknown[] = []; host.onEvent((event) => events.push(event));
    await host.start(base());
    timeout?.();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ name: 'failed', payload: { error: 'timeout' } });
  });

  it('keeps progress monotonic and at most 99 until completion', async () => {
    transport = { send: vi.fn(async (request) => { request.onProgress(10, 100); request.onProgress(4, 100); request.onProgress(100, 100); return { statusCode: 200 }; }) };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers, random: () => 0, packaged: true });
    const events: Array<{ name: string; payload?: { percent?: number } }> = [];
    host.onEvent((event) => events.push(event));
    await host.start(base());
    await vi.waitFor(() => expect(events.at(-1)?.name).toBe('completed'));
    const progress = events.filter((event) => event.name === 'uploading').map((event) => event.payload?.percent ?? -1);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((value, index) => value <= 99 && (index === 0 || value >= progress[index - 1]!))).toBe(true);
  });

  it('abortAll emits one aborted failure per active request, suppresses late responses and accepts a later start', async () => {
    let finish: ((value: { statusCode: number }) => void) | undefined;
    let seenSignal: AbortSignal | undefined;
    let calls = 0;
    transport = { send: (request) => {
      seenSignal = request.signal;
      calls += 1;
      if (calls > 1) return Promise.resolve({ statusCode: 201 });
      return new Promise((resolve) => { finish = resolve; });
    } };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers, random: () => 0, packaged: true });
    const events: Array<{ name: string; payload?: { error?: string } }> = [];
    host.onEvent((event) => events.push(event));
    const first = await host.start(base());
    host.abortAll('suspend');
    expect(seenSignal?.aborted).toBe(true);
    finish?.({ statusCode: 201 });
    await vi.waitFor(() => expect(events.filter((event) => event.name === 'failed')).toHaveLength(1));
    expect(events).toEqual([{ name: 'failed', id: first.id, payload: { error: 'aborted' } }]);
    await expect(host.start(base())).resolves.toHaveProperty('id');
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[1]).toMatchObject({ name: 'completed', payload: { statusCode: 201 } });
  });

  it('abortAll cancels a resolver-pending upload before transport and allows a later start', async () => {
    let resolveFile!: (file: { path: string; size: number }) => void;
    const deferredResolver = () => new Promise<{ path: string; size: number }>((resolve) => { resolveFile = resolve; });
    let calls = 0;
    transport = { send: vi.fn(async () => { calls += 1; return { statusCode: 200 }; }) };
    host = createUploaderHost({ transport, resolveMediaFile: deferredResolver, timers, random: () => 0, packaged: true });
    const events: unknown[] = [];
    const counts: number[] = [];
    host.onEvent((event) => events.push(event));
    host.onActiveCountChange((count) => counts.push(count));

    const starting = host.start(base());
    await vi.waitFor(() => expect(host.activeCount()).toBe(1));
    const cancelledId = uploadIds.last;
    host.abortAll('suspend');
    // native-uploader buffers this terminal event until the start promise supplies its id.
    expect(events).toEqual([{ name: 'failed', id: cancelledId, payload: { error: 'aborted' } }]);
    await expect(starting).resolves.toHaveProperty('id', cancelledId);
    expect(events).toEqual([{ name: 'failed', id: cancelledId, payload: { error: 'aborted' } }]);
    expect(host.activeCount()).toBe(0);
    resolveFile({ path: file, size: 3 });
    await Promise.resolve();
    expect(calls).toBe(0);
    expect(events).toHaveLength(1);

    const later = host.start(base());
    await vi.waitFor(() => expect(host.activeCount()).toBe(1));
    const laterId = uploadIds.last;
    resolveFile({ path: file, size: 3 });
    await expect(later).resolves.toHaveProperty('id', laterId);
    await vi.waitFor(() => expect(host.activeCount()).toBe(0));
    expect(calls).toBe(1);
    expect(events).toHaveLength(2);
    expect(counts).toEqual([1, 0, 1, 0]);
  });

  it('remove cancels a resolver-pending upload without events or transport', async () => {
    let resolveFile!: (file: { path: string; size: number }) => void;
    const deferredResolver = () => new Promise<{ path: string; size: number }>((resolve) => { resolveFile = resolve; });
    const send = vi.fn(async () => ({ statusCode: 200 }));
    transport = { send };
    host = createUploaderHost({ transport, resolveMediaFile: deferredResolver, timers, random: () => 0, packaged: true });
    const events: unknown[] = [];
    const counts: number[] = [];
    host.onEvent((event) => events.push(event));
    host.onActiveCountChange((count) => counts.push(count));

    const starting = host.start(base());
    await vi.waitFor(() => expect(host.activeCount()).toBe(1));
    const removedId = uploadIds.last;
    await host.remove(removedId);
    await expect(starting).resolves.toHaveProperty('id', removedId);
    expect(host.activeCount()).toBe(0);
    expect(events).toEqual([]);
    resolveFile({ path: file, size: 3 });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(counts).toEqual([1, 0]);
  });

  it('remove waits for transfer settlement and suppresses all following events', async () => {
    let finish: ((value: { statusCode: number }) => void) | undefined;
    transport = { send: () => new Promise((resolve) => { finish = resolve; }) };
    host = createUploaderHost({ transport, resolveMediaFile: createMediaFileResolver({ fs: await import('node:fs/promises'), mediaRoot: media, cacheRoot: cache }), timers, random: () => 0, packaged: true });
    const events: unknown[] = []; host.onEvent((event) => events.push(event));
    const task = await host.start(base());
    const removed = host.remove(task.id);
    finish?.({ statusCode: 200 });
    await removed;
    expect(events).toEqual([]);
    expect(host.activeCount()).toBe(0);
  });

  it('disposes listener subscriptions independently', async () => {
    const first = vi.fn(); const second = vi.fn();
    const disposeFirst = host.onEvent(first); host.onEvent(second);
    disposeFirst();
    await host.start(base());
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(first).not.toHaveBeenCalled();
  });
});
