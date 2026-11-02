import { mkdtemp, rm, mkdir, symlink, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFilesHost } from './files-host.ts';

describe('createFilesHost', () => {
  let root: string;
  let outside: string;
  let host: ReturnType<typeof createFilesHost>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oi-files-'));
    outside = await mkdtemp(join(tmpdir(), 'oi-outside-'));
    host = createFilesHost({ fs: await import('node:fs/promises'), mediaRoot: join(root, 'media'), cacheRoot: join(root, 'cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
  });
  afterEach(async () => { await host?.dispose?.(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); });

  it.each(['CON', 'NUL', 'aux.txt', 'CON .jpg', 'CONIN$', 'COM¹.log', 'LPT9.log', 'foo.', 'foo ', 'a.jpg:stream', '\\\\?\\C:\\x', 'C:/x', '//server/share/x', '../x', 'x/../../y', 'x'.repeat(201)])('rejects unsafe Windows path %s', async (path) => {
    await expect(host.read(path)).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('allows normal nested paths under the selected root', async () => {
    await expect(host.write('nested/Photo.JPG', Uint8Array.from([0xff, 0xd8, 0xff]))).resolves.toMatch(/^file:\/\//);
    expect(await host.read('nested/Photo.JPG')).toEqual(Uint8Array.from([0xff, 0xd8, 0xff]));
  });
  it('releases one media quota slot only after a successful delete', async () => {
    const media = join(root, 'quota-media');
    await mkdir(media);
    const realFs = await import('node:fs/promises');
    for (let start = 1; start < 10_000; start += 100) {
      await Promise.all(Array.from({ length: Math.min(100, 10_000 - start) }, (_, offset) => {
        const index = start + offset;
        return writeFile(join(media, `existing-${String(index).padStart(5, '0')}.jpg`), new Uint8Array(0));
      }));
    }
    await writeFile(join(media, 'existing-00000.jpg'), new Uint8Array(0));
    const failingDeleteFs = { ...realFs, unlink: async (path: Parameters<typeof realFs.unlink>[0]) => {
      if (String(path).endsWith('existing-00001.jpg')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return realFs.unlink(path);
    } };
    const capped = createFilesHost({ fs: failingDeleteFs as never, mediaRoot: media, cacheRoot: join(root, 'quota-cache'), clock: { now: Date.now, setTimeout, clearTimeout } });

    await expect(capped.write('extra.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).rejects.toMatchObject({ code: 'invalid-argument' });
    await capped.remove('missing.jpg');
    await expect(capped.write('still-full.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(capped.remove('existing-00001.jpg')).rejects.toMatchObject({ code: 'EACCES' });
    await expect(capped.write('still-full-after-failure.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).rejects.toMatchObject({ code: 'invalid-argument' });

    await capped.remove('existing-00000.jpg');
    await expect(capped.write('replacement.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).resolves.toMatch(/^file:\/\//);
    await capped.dispose();
  });
  it('refuses a directory junction that resolves outside the root', async () => {
    await mkdir(join(root, 'media'), { recursive: true });
    await symlink(outside, join(root, 'media', 'escape'), 'junction');
    await expect(host.write('escape/file.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).rejects.toBeDefined();
  });
  it('exists is false only for ENOENT and propagates other errors', async () => {
    expect(await host.exists('missing.jpg')).toBe(false);
    const deniedFs = { ...await import('node:fs/promises'), stat: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
    const denied = createFilesHost({ fs: deniedFs as never, mediaRoot: join(root, 'm'), cacheRoot: join(root, 'c'), clock: { now: Date.now, setTimeout, clearTimeout } });
    await expect(denied.exists('a.jpg')).rejects.toMatchObject({ code: 'EACCES' });
    await denied.dispose?.();
  });
  it('lists a missing directory as empty and preserves on-disk casing', async () => {
    expect(await host.list('missing')).toEqual([]);
    await host.write('Dir/MiXeD.jpg', Uint8Array.from([0xff, 0xd8, 0xff]));
    expect(await host.list('Dir')).toEqual([{ name: 'MiXeD.jpg', mtimeMs: expect.any(Number) }]);
    expect(await host.list('media')).toEqual([{ name: 'Dir', mtimeMs: expect.any(Number) }]);
  });
  it('stores a webp picture (the photo cache copy) under photo-cache/, shows it through the media scheme, and refuses bytes that are not webp', async () => {
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x45, 0x42, 0x50, 1, 2]);
    await expect(host.write('photo-cache/abc.webp', webp)).resolves.toMatch(/^file:\/\//);
    expect(await host.read('photo-cache/abc.webp')).toEqual(webp);
    expect(await host.displayUrl('photo-cache/abc.webp')).toBe('oi-media://media/photo-cache/abc.webp');
    // Control: the same extension with jpeg bytes, and a riff file that is not webp, are refused.
    await expect(host.write('photo-cache/bad.webp', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(host.write('photo-cache/wav.webp', Uint8Array.from([0x52, 0x49, 0x46, 0x46, 9, 9, 9, 9, 0x57, 0x41, 0x56, 0x45, 1]))).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('maps ENOSPC to disk-full', async () => {
    const noSpaceFs = { ...await import('node:fs/promises'), mkdir: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } };
    const noSpace = createFilesHost({ fs: noSpaceFs as never, mediaRoot: join(root, 'm'), cacheRoot: join(root, 'c'), clock: { now: Date.now, setTimeout, clearTimeout } });
    await expect(noSpace.write('x.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).rejects.toMatchObject({ code: 'disk-full' });
    await noSpace.dispose?.();
  });
  it('overwrites an existing target when the same path is written twice, as the Android implementation does', async () => {
    await host.write('same.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    await expect(host.write('same.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 2, 2]))).resolves.toMatch(/^file:\/\//);
    expect(await host.read('same.jpg')).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 2, 2]));
    expect(await host.list('')).toEqual([{ name: 'same.jpg', mtimeMs: expect.any(Number) }]);
  });
  it('keeps the old content and leaves no part file when the commit itself fails', async () => {
    const realFs = await import('node:fs/promises');
    const failingRename = { ...realFs, rename: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } };
    const media = join(root, 'rename-media');
    const old = createFilesHost({ fs: realFs, mediaRoot: media, cacheRoot: join(root, 'rename-cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    await old.write('same.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    await old.dispose();
    const failing = createFilesHost({ fs: failingRename as never, mediaRoot: media, cacheRoot: join(root, 'rename-cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    await expect(failing.write('same.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 2]))).rejects.toMatchObject({ code: 'EPERM' });
    expect(await failing.read('same.jpg')).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    expect(await failing.list('')).toEqual([{ name: 'same.jpg', mtimeMs: expect.any(Number) }]);
    await failing.dispose();
  });
  it('cleans only its own part file after a stream write error', async () => {
    const realFs = await import('node:fs/promises');
    const failingFs = { ...realFs, open: async (...args: Parameters<typeof realFs.open>) => {
      const file = await realFs.open(...args);
      return { stat: () => file.stat(), write: async () => { throw Object.assign(new Error('disk failed'), { code: 'EIO' }); }, sync: () => file.sync(), close: () => file.close() };
    } };
    const failing = createFilesHost({ fs: failingFs as never, mediaRoot: join(root, 'failing-media'), cacheRoot: join(root, 'failing-cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    const { handle } = await failing.stream.open('cache', 'owned.bin');
    await expect(failing.stream.append(handle, Uint8Array.from([1]))).rejects.toMatchObject({ code: 'EIO' });
    expect(await failing.listCache()).toEqual([]);
    await failing.dispose();
  });
  it('aborts stream and removes its own part file', async () => {
    const { handle } = await host.stream.open('cache', 'tmp.zip');
    await host.stream.append(handle, Uint8Array.from([1, 2]));
    await host.stream.finish(handle, 'abort');
    expect(await host.listCache()).toEqual([]);
  });
  it('queues a fifth active stream until a slot is released', async () => {
    const first = await Promise.all(Array.from({ length: 4 }, (_, i) => host.stream.open('cache', `${i}.bin`)));
    let opened = false;
    const fifth = host.stream.open('cache', '5.bin').then((v) => { opened = true; return v; });
    await Promise.resolve();
    expect(opened).toBe(false);
    await host.stream.finish(first[0]!.handle, 'abort');
    expect((await fifth).handle).toBeTruthy();
  });
  it('rejects queued stream opens when the renderer is destroyed', async () => {
    const opened = await Promise.all(Array.from({ length: 4 }, (_, i) => host.stream.open('cache', `queued-${i}.bin`)));
    const pending = host.stream.open('cache', 'queued-fifth.bin');
    const rejected = expect(pending).rejects.toBeDefined();
    await Promise.resolve();
    await host.abortAll();
    await rejected;
    expect(await host.listCache()).toEqual([]);
    await expect(host.stream.open('cache', 'after-reload.bin')).resolves.toHaveProperty('handle');
    await host.abortAll();
    expect(opened).toHaveLength(4);
  });
  it('emits the exact encoded file and display URIs', async () => {
    expect(await host.fileUri('folder/a b.jpg')).toBe(pathToFileURL(join(await realpath(join(root, 'media')), 'folder', 'a b.jpg')).href);
    expect(await host.displayUrl('folder/a b.jpg')).toBe('oi-media://media/folder/a%20b.jpg');
  });
  it('aborts an idle stream after sixty seconds', async () => {
    const callbacks: Array<() => void> = [];
    const timed = createFilesHost({ fs: await import('node:fs/promises'), mediaRoot: join(root, 'timed-media'), cacheRoot: join(root, 'timed-cache'), clock: { now: Date.now, setTimeout: ((callback: () => void) => { callbacks.push(callback); return callbacks.length as never; }) as unknown as typeof setTimeout, clearTimeout: (() => undefined) as typeof clearTimeout } });
    const { handle } = await timed.stream.open('cache', 'idle.bin');
    callbacks[0]?.();
    await expect(timed.stream.finish(handle, 'commit')).rejects.toBeDefined();
    expect(await timed.listCache()).toEqual([]);
    await timed.dispose();
  });
  it('aborts all open streams when the renderer is destroyed', async () => {
    const { handle } = await host.stream.open('cache', 'renderer.bin');
    await host.stream.append(handle, Uint8Array.from([1]));
    await host.abortAll();
    expect(await host.listCache()).toEqual([]);
    await expect(host.stream.finish(handle, 'commit')).rejects.toBeDefined();
  });
  it('does not let an idle timeout abort a commit after target creation begins', async () => {
    const callbacks: Array<() => void> = [];
    const realFs = await import('node:fs/promises');
    let finishLink!: () => void;
    let enteredLink!: () => void;
    const linkEntered = new Promise<void>((resolve) => { enteredLink = resolve; });
    const gatedFs = { ...realFs, rename: async (...args: Parameters<typeof realFs.rename>) => {
      enteredLink();
      await new Promise<void>((resolve) => { finishLink = resolve; });
      return realFs.rename(...args);
    } };
    const timed = createFilesHost({ fs: gatedFs as never, mediaRoot: join(root, 'commit-media'), cacheRoot: join(root, 'commit-cache'), clock: { now: Date.now, setTimeout: ((callback: () => void) => { callbacks.push(callback); return callbacks.length as never; }) as unknown as typeof setTimeout, clearTimeout: (() => undefined) as typeof clearTimeout } });
    const { handle } = await timed.stream.open('cache', 'commit.bin');
    await timed.stream.append(handle, Uint8Array.from([1]));
    const commit = timed.stream.finish(handle, 'commit');
    await linkEntered;
    callbacks[0]?.();
    finishLink();
    await expect(commit).resolves.toMatch(/^file:/);
    expect(await timed.listCache()).toEqual([{ name: 'commit.bin', mtimeMs: expect.any(Number) }]);
    expect([...await (await import('node:fs/promises')).readFile(join(root, 'commit-cache', 'commit.bin'))]).toEqual([1]);
    await timed.dispose();
  });
  it('does not let a junction swap between validation and open write outside the media root', async () => {
    const realFs = await import('node:fs/promises');
    const media = join(root, 'race-media');
    const outsideDir = join(outside, 'dest');
    await mkdir(join(media, 'nested'), { recursive: true });
    await mkdir(outsideDir);
    await realFs.writeFile(join(outsideDir, 'sentinel.jpg'), Uint8Array.from([1, 2, 3]));
    let swapped = false;
    const raceFs = { ...realFs, open: async (...args: Parameters<typeof realFs.open>) => {
      if (!swapped && String(args[0]).endsWith(join('nested', 'new.jpg.part'))) {
        swapped = true;
        await realFs.rename(join(media, 'nested'), join(media, 'nested-original'));
        await symlink(outsideDir, join(media, 'nested'), 'junction');
      }
      return realFs.open(...args);
    } };
    const raced = createFilesHost({ fs: raceFs as never, mediaRoot: media, cacheRoot: join(root, 'race-cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    await expect(raced.write('nested/new.jpg', Uint8Array.from([0xff, 0xd8, 0xff]))).rejects.toBeDefined();
    expect([...await realFs.readFile(join(outsideDir, 'sentinel.jpg'))]).toEqual([1, 2, 3]);
    await expect(realFs.stat(join(outsideDir, 'new.jpg.part'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(realFs.stat(join(outsideDir, 'new.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
    await raced.dispose();
  });
  it('returns an empty cache listing when resolving a missing cache root yields ENOENT', async () => {
    const realFs = await import('node:fs/promises');
    const cache = join(root, 'missing-cache');
    const missingFs = { ...realFs, realpath: async (path: Parameters<typeof realFs.realpath>[0]) => {
      if (path === cache) throw Object.assign(new Error('missing cache root'), { code: 'ENOENT' });
      return realFs.realpath(path);
    } };
    const missing = createFilesHost({ fs: missingFs as never, mediaRoot: join(root, 'missing-media'), cacheRoot: cache, clock: { now: Date.now, setTimeout, clearTimeout } });
    await expect(missing.listCache()).resolves.toEqual([]);
    await missing.dispose();
  });
  it('propagates non-ENOENT cache-root errors', async () => {
    const realFs = await import('node:fs/promises');
    const cache = join(root, 'denied-cache');
    const deniedFs = { ...realFs, realpath: async (path: Parameters<typeof realFs.realpath>[0]) => {
      if (path === cache) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return realFs.realpath(path);
    } };
    const denied = createFilesHost({ fs: deniedFs as never, mediaRoot: join(root, 'denied-media'), cacheRoot: cache, clock: { now: Date.now, setTimeout, clearTimeout } });
    await expect(denied.listCache()).rejects.toMatchObject({ code: 'EACCES' });
    await denied.dispose();
  });
});
