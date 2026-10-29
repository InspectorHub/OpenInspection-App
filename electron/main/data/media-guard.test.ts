import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MEDIA_BYTES, MAX_VIDEO_BYTES } from '../../../src/media/media-types.ts';
import { createFilesHost } from './files-host.ts';

describe('media byte guard', () => {
  let root: string;
  let files: ReturnType<typeof createFilesHost>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'oi-media-guard-'));
    files = createFilesHost({ fs: await import('node:fs/promises'), mediaRoot: join(root, 'media'), cacheRoot: join(root, 'cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
  });
  afterEach(async () => { await files?.dispose?.(); await rm(root, { recursive: true, force: true }); });
  const stream = async (path: string, chunks: Uint8Array[]) => {
    const { handle } = await files.stream.open('media', path);
    for (const chunk of chunks) await files.stream.append(handle, chunk);
    return files.stream.finish(handle, 'commit');
  };
  const jpg = Uint8Array.from([0xff, 0xd8, 0xff, 1]);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
  const heic = (brand = 'heic') => Uint8Array.from([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode(brand), 0, 0, 0, 0, ...new TextEncoder().encode('mif1')]);
  it('accepts JPEG, PNG, HEIC and HEIC mif1 brand', async () => {
    await expect(files.write('a.jpg', jpg)).resolves.toMatch(/^file:/);
    await expect(files.write('b.png', png)).resolves.toMatch(/^file:/);
    await expect(files.write('c.heic', heic())).resolves.toMatch(/^file:/);
    await expect(files.write('d.heic', heic('mif1'))).resolves.toMatch(/^file:/);
    await expect(files.write('e.heic', heic('foo1'))).resolves.toMatch(/^file:/);
  });
  it('accepts mp4 and mov containers by their ftyp signature', async () => {
    const mp4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, ...new TextEncoder().encode('mp42')]);
    await expect(files.write('clip.mp4', mp4)).resolves.toMatch(/^file:/);
    await expect(files.write('clip.mov', mp4)).resolves.toMatch(/^file:/);
  });
  it.each([
    ['avif brand', 'a.heic', heic('avif')], ['renamed text', 'a.heic', new TextEncoder().encode('not an image')],
    ['executable jpg', 'a.jpg', Uint8Array.from([0x4d, 0x5a, 0, 0])], ['jpeg png', 'a.png', jpg], ['zero bytes', 'a.jpg', new Uint8Array()],
    ['unsupported extension', 'a.gif', jpg],
  ])('rejects %s without leaving files', async (_name, path, data) => {
    await expect(files.write(path, data)).rejects.toBeDefined();
    expect(await files.exists(path)).toBe(false);
  });
  it('rejects oversize photo before writing a chunk and removes the part', async () => {
    const { handle } = await files.stream.open('media', 'large.jpg');
    await expect(files.stream.append(handle, new Uint8Array(MAX_MEDIA_BYTES + 1))).rejects.toBeDefined();
    expect(await files.list('')).toEqual([]);
  });
  it('rejects oversize clip and unsupported extension without leftovers', async () => {
    const { handle } = await files.stream.open('media', 'large.mp4');
    await expect(files.stream.append(handle, new Uint8Array(MAX_VIDEO_BYTES + 1))).rejects.toBeDefined();
    expect(await files.list('')).toEqual([]);
    await expect(stream('bad.bin', [jpg])).rejects.toBeDefined();
    expect(await files.list('')).toEqual([]);
  });
  it('allows the 10,000th media file and refuses the 10,001st', async () => {
    // Seed pre-existing files directly to exercise the startup count without 10,000 IPC writes.
    await (await import('node:fs/promises')).mkdir(join(root, 'media'), { recursive: true });
    const disk = await import('node:fs/promises');
    for (let start = 0; start < 9999; start += 250) {
      await Promise.all(Array.from({ length: Math.min(250, 9999 - start) }, (_, offset) => disk.writeFile(join(root, 'media', `seed-${start + offset}.bin`), 'x')));
    }
    await files.dispose?.();
    files = createFilesHost({ fs: await import('node:fs/promises'), mediaRoot: join(root, 'media'), cacheRoot: join(root, 'cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    await expect(files.write('tenthousand.jpg', jpg)).resolves.toMatch(/^file:/);
    await expect(files.write('tenkone.jpg', jpg)).rejects.toBeDefined();
  });
  it('serializes concurrent quota check and commit at the 10,000-file boundary', async () => {
    const disk = await import('node:fs/promises');
    const dir = join(root, 'media');
    await disk.mkdir(dir, { recursive: true });
    for (let start = 0; start < 9997; start += 250) {
      await Promise.all(Array.from({ length: Math.min(250, 9997 - start) }, (_, offset) => disk.writeFile(join(dir, `race-seed-${start + offset}.bin`), 'x')));
    }
    await files.dispose?.();
    files = createFilesHost({ fs: disk, mediaRoot: dir, cacheRoot: join(root, 'cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    const handles = await Promise.all(Array.from({ length: 4 }, (_, i) => files.stream.open('media', `race-${i}.jpg`)));
    await Promise.all(handles.map(({ handle }) => files.stream.append(handle, jpg)));
    const results = await Promise.allSettled(handles.map(({ handle }) => files.stream.finish(handle, 'commit')));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const listed = await files.list('');
    expect(listed.filter(({ name }) => name.startsWith('race-') && name.endsWith('.jpg'))).toHaveLength(3);
  });
  it('queues a fifth concurrent media write', async () => {
    const opens = await Promise.all(Array.from({ length: 4 }, (_, i) => files.stream.open('media', `q${i}.jpg`)));
    const queued = files.stream.open('media', 'q4.jpg');
    await files.stream.finish(opens[0]!.handle, 'abort');
    await expect(queued).resolves.toHaveProperty('handle');
  });
});
