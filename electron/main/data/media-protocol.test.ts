import { describe, expect, it, vi } from 'vitest';
import { createMediaFileResponse, createMediaProtocolHandler } from './media-protocol.ts';
import { mkdtemp, open, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('createMediaProtocolHandler', () => {
  const call = async (url: string, init: RequestInit = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'oi-protocol-call-'));
    await writeFile(join(root, 'a.jpg'), 'bytes');
    const fetchFile = vi.fn(async (file: Awaited<ReturnType<typeof open>>, _options: { headers: Headers; method: 'GET' | 'HEAD' }) => {
      await file.close();
      return new Response('bytes', { status: 206, headers: { 'Content-Range': 'bytes 0-4/5' } });
    });
    const handler = createMediaProtocolHandler({ mediaRoot: root, fetchFile });
    const response = await handler(new Request(url, init));
    await rm(root, { recursive: true, force: true });
    return { response, fetchFile };
  };
  it('serves only requests whose decoded path remains within media root', async () => {
    expect((await call('oi-media://media/a.jpg')).response.status).toBe(206);
    const traversal = await call('oi-media://media/%2e%2e/secret.txt');
    expect(traversal.response.status).toBe(404);
    expect(traversal.fetchFile).not.toHaveBeenCalled();
  });
  it('allows GET and HEAD only', async () => {
    expect((await call('oi-media://media/a.jpg', { method: 'POST' })).response.status).toBe(405);
    expect((await call('oi-media://media/a.jpg', { method: 'HEAD' })).response.status).toBe(206);
  });
  it('sets the MIME allowlist, nosniff, no-store, and forwards Range', async () => {
    const { response, fetchFile } = await call('oi-media://media/a.jpg', { headers: { Range: 'bytes=0-2' } });
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fetchFile.mock.calls[0]?.[1].headers.get('range')).toBe('bytes=0-2');
  });
  it('serves a webp file in a sub folder as image/webp', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oi-protocol-webp-'));
    try {
      await import('node:fs/promises').then(({ mkdir }) => mkdir(join(root, 'photo-cache')));
      await writeFile(join(root, 'photo-cache', 'a.webp'), 'bytes');
      const handler = createMediaProtocolHandler({ mediaRoot: root, fetchFile: createMediaFileResponse });
      const response = await handler(new Request('oi-media://media/photo-cache/a.webp'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      expect(await response.text()).toBe('bytes');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects extensions outside the media MIME allowlist', async () => {
    expect((await call('oi-media://media/a.html')).response.status).toBe(404);
  });
  it('does not serve a linked file that resolves outside the media root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oi-protocol-media-'));
    const outside = await mkdtemp(join(tmpdir(), 'oi-protocol-outside-'));
    try {
      await writeFile(join(outside, 'secret.jpg'), 'secret');
      await symlink(outside, join(root, 'escape'), 'junction');
      const fetchFile = vi.fn(async () => new Response('secret'));
      const handler = createMediaProtocolHandler({ mediaRoot: root, fetchFile });
      expect((await handler(new Request('oi-media://media/escape/secret.jpg'))).status).toBe(404);
      expect(fetchFile).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
  it('closes the validation-to-open race before reading a swapped outside file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oi-protocol-race-'));
    const outside = await mkdtemp(join(tmpdir(), 'oi-protocol-race-outside-'));
    const media = join(root, 'media');
    await import('node:fs/promises').then(({ mkdir }) => mkdir(join(media, 'sub'), { recursive: true }));
    await writeFile(join(outside, 'photo.jpg'), 'outside-secret');
    await writeFile(join(media, 'sub', 'photo.jpg'), 'inside');
    const realFs = await import('node:fs/promises');
    let swapped = false;
    const fs = { open: async (path: string, flags: string) => {
      if (!swapped && path === join(media, 'sub', 'photo.jpg')) {
        swapped = true;
        await realFs.rename(join(media, 'sub'), join(media, 'sub-original'));
        await symlink(outside, join(media, 'sub'), 'junction');
      }
      return realFs.open(path, flags as 'r');
    }, realpath: realpath };
    const fetchFile = vi.fn(createMediaFileResponse);
    try {
      const handler = createMediaProtocolHandler({ mediaRoot: media, fs: fs as never, fetchFile });
      const response = await handler(new Request('oi-media://media/sub/photo.jpg'));
      expect(response.status).toBe(404);
      expect(fetchFile).not.toHaveBeenCalled();
      expect(await realFs.readFile(join(outside, 'photo.jpg'), 'utf8')).toBe('outside-secret');
    } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
  it('serves closed, open-ended, and suffix ranges and rejects invalid or unsatisfiable ranges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-range-'));
    const filePath = join(dir, 'ten.jpg');
    await writeFile(filePath, '0123456789');
    const files: Awaited<ReturnType<typeof open>>[] = [];
    try {
      const responseFor = async (range?: string) => {
        const file = await open(filePath, 'r');
        files.push(file);
        return createMediaFileResponse(file, { headers: new Headers(range ? { range } : {}), method: 'GET' });
      };
      const closed = await responseFor('bytes=2-4');
      expect([closed.status, await closed.text(), closed.headers.get('content-range')]).toEqual([206, '234', 'bytes 2-4/10']);
      const openEnded = await responseFor('bytes=7-');
      expect([openEnded.status, await openEnded.text()]).toEqual([206, '789']);
      const suffix = await responseFor('bytes=-3');
      expect([suffix.status, await suffix.text(), suffix.headers.get('content-range')]).toEqual([206, '789', 'bytes 7-9/10']);
      expect((await responseFor('bytes=nope')).status).toBe(416);
      expect((await responseFor('bytes=20-')).status).toBe(416);
    } finally {
      // The handler normally owns these handles; this unit test calls the response factory directly.
      await Promise.all(files.map((file) => file.close().catch(() => undefined)));
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('answers HEAD metadata without creating a read stream', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-head-'));
    const filePath = join(dir, 'head.jpg');
    await writeFile(filePath, 'head-data');
    const handle = await open(filePath, 'r');
    const streamSpy = vi.spyOn(handle, 'createReadStream');
    try {
      const response = await createMediaFileResponse(handle, { headers: new Headers(), method: 'HEAD' });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe('9');
      expect(streamSpy).not.toHaveBeenCalled();
    } finally { await handle.close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
  });

  it('closes an opened handle when post-open validation fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-post-open-failure-'));
    const filePath = join(dir, 'photo.jpg');
    await writeFile(filePath, 'photo');
    const realFs = await import('node:fs/promises');
    const file = await realFs.open(filePath, 'r');
    const close = vi.spyOn(file, 'close');
    try {
      const handler = createMediaProtocolHandler({
        mediaRoot: dir,
        fs: { open: async () => file, realpath, stat: async () => { throw new Error('injected stat failure'); } },
        fetchFile: createMediaFileResponse,
      });
      expect((await handler(new Request('oi-media://media/photo.jpg'))).status).toBe(404);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await file.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes an opened handle when the response callback fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-fetch-failure-'));
    const filePath = join(dir, 'photo.jpg');
    await writeFile(filePath, 'photo');
    const realFs = await import('node:fs/promises');
    const file = await realFs.open(filePath, 'r');
    const close = vi.spyOn(file, 'close');
    try {
      const handler = createMediaProtocolHandler({
        mediaRoot: dir,
        fs: { open: async () => file, realpath, stat: realFs.stat },
        fetchFile: async () => { throw new Error('injected response failure'); },
      });
      expect((await handler(new Request('oi-media://media/photo.jpg'))).status).toBe(404);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await file.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes a successful GET handle when its response stream completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-stream-complete-'));
    const filePath = join(dir, 'photo.jpg');
    await writeFile(filePath, 'photo');
    const realFs = await import('node:fs/promises');
    const file = await realFs.open(filePath, 'r');
    const close = vi.spyOn(file, 'close');
    try {
      const handler = createMediaProtocolHandler({
        mediaRoot: dir,
        fs: { open: async () => file, realpath, stat: realFs.stat },
        fetchFile: createMediaFileResponse,
      });
      const response = await handler(new Request('oi-media://media/photo.jpg'));
      await expect(response.text()).resolves.toBe('photo');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await file.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes a successful GET handle when the response stream is cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-stream-cancel-'));
    const filePath = join(dir, 'photo.jpg');
    await writeFile(filePath, 'photo');
    const realFs = await import('node:fs/promises');
    const file = await realFs.open(filePath, 'r');
    const close = vi.spyOn(file, 'close');
    try {
      const handler = createMediaProtocolHandler({
        mediaRoot: dir,
        fs: { open: async () => file, realpath, stat: realFs.stat },
        fetchFile: createMediaFileResponse,
      });
      const response = await handler(new Request('oi-media://media/photo.jpg'));
      await response.body?.cancel();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await file.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes a successful GET handle when the response stream errors', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-stream-error-'));
    const filePath = join(dir, 'photo.jpg');
    await writeFile(filePath, 'photo');
    const realFs = await import('node:fs/promises');
    const file = await realFs.open(filePath, 'r');
    const close = vi.spyOn(file, 'close');
    try {
      const handler = createMediaProtocolHandler({
        mediaRoot: dir,
        fs: { open: async () => file, realpath, stat: realFs.stat },
        fetchFile: async () => new Response(new ReadableStream({
          start(controller) { controller.error(new Error('injected stream failure')); },
        })),
      });
      const response = await handler(new Request('oi-media://media/photo.jpg'));
      await expect(response.text()).rejects.toThrow('injected stream failure');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await file.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes a successful HEAD handle after returning metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-head-protocol-'));
    const filePath = join(dir, 'photo.jpg');
    await writeFile(filePath, 'photo');
    const realFs = await import('node:fs/promises');
    const file = await realFs.open(filePath, 'r');
    const close = vi.spyOn(file, 'close');
    try {
      const handler = createMediaProtocolHandler({
        mediaRoot: dir,
        fs: { open: async () => file, realpath, stat: realFs.stat },
        fetchFile: createMediaFileResponse,
      });
      const response = await handler(new Request('oi-media://media/photo.jpg', { method: 'HEAD' }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-length')).toBe('5');
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await file.close().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
