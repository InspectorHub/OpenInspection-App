import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GALLERY_FILE_NAME, IpcError } from '../shared/ipc-contract.ts';
import { createGalleryHost, GALLERY_FOLDER, type GalleryFsLike } from './gallery.ts';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const pictures = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'gallery-host-'));
  dirs.push(dir);
  return dir;
};

/** The real file system, with the exclusive-create write the host asks for. */
const realFs: GalleryFsLike = {
  mkdir: (path, options) => mkdir(path, options),
  writeNew: (path, data) => writeFile(path, data, { flag: 'wx' }),
};
const NAME = 'InspectorHub-20261102-101500-ab12cd34.jpg';
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

describe('the gallery host, on the real file system', () => {
  it('creates Pictures/InspectorHub and writes the photo into it byte for byte', async () => {
    const root = pictures();
    await expect(createGalleryHost({ fs: realFs, picturesDir: root }).save(NAME, BYTES)).resolves.toBe('saved');
    expect(readdirSync(join(root, GALLERY_FOLDER))).toEqual([NAME]);
    expect([...readFileSync(join(root, GALLERY_FOLDER, NAME))]).toEqual([...BYTES]);
  });

  it('saving the same photo again is saved, and does not change the file that is there (control: a different name is a second file)', async () => {
    const root = pictures();
    const host = createGalleryHost({ fs: realFs, picturesDir: root });
    await host.save(NAME, BYTES);
    await expect(host.save(NAME, new Uint8Array([9, 9, 9]))).resolves.toBe('saved');
    expect([...readFileSync(join(root, GALLERY_FOLDER, NAME))]).toEqual([...BYTES]);
    await host.save('InspectorHub-20261102-101600-ef56ab78.jpg', BYTES);
    expect(readdirSync(join(root, GALLERY_FOLDER))).toHaveLength(2);
  });

  it('never replaces or removes a file the person put in that folder', async () => {
    const root = pictures();
    const host = createGalleryHost({ fs: realFs, picturesDir: root });
    await host.save(NAME, BYTES);
    writeFileSync(join(root, GALLERY_FOLDER, 'mine.jpg'), 'keep');
    await host.save('InspectorHub-20261102-101700-aa11bb22.png', BYTES);
    expect(readFileSync(join(root, GALLERY_FOLDER, 'mine.jpg'), 'utf8')).toBe('keep');
  });
});

describe('what the host refuses and how it reports a failure', () => {
  const failing = (code: string): GalleryFsLike => ({
    mkdir: () => Promise.resolve(),
    writeNew: () => Promise.reject(Object.assign(new Error(`${code} C:\\Users\\bob\\Pictures`), { code })),
  });
  const codeOfError = async (promise: Promise<unknown>): Promise<string> => {
    try { await promise; return 'none'; } catch (error) { return error instanceof IpcError ? error.code : 'other'; }
  };

  it.each([
    ['ENOSPC', 'disk-full'],
    ['EACCES', 'unavailable'],
    ['EPERM', 'unavailable'],
    ['EROFS', 'unavailable'],
    ['EIO', 'internal'],
    ['', 'internal'],
  ])('a write failure %s reaches the renderer as the closed code %s, never as text', async (code, expected) => {
    expect(await codeOfError(createGalleryHost({ fs: failing(code), picturesDir: 'X:\\Pictures' }).save(NAME, BYTES))).toBe(expected);
  });

  it('a failing mkdir is reported too', async () => {
    const fs: GalleryFsLike = { mkdir: () => Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })), writeNew: () => Promise.resolve() };
    expect(await codeOfError(createGalleryHost({ fs, picturesDir: 'X:\\Pictures' }).save(NAME, BYTES))).toBe('unavailable');
  });

  it.each([
    '../evil.jpg',
    '..\\evil.jpg',
    'InspectorHub-20261102-101500-ab12cd34.exe',
    'InspectorHub-20261102-101500-ab12cd34.jpg.exe',
    'InspectorHub-20261102-101500-ab12cd34.JPG',
    'InspectorHub-20261102-101500-../x.jpg',
    'InspectorHub-20261102-101500-.jpg',
    'photo.jpg',
    '',
    'InspectorHub-20261102-101500-ab12cd34.jpg\0.exe',
  ])('refuses the name %j before touching the disk', async (name) => {
    let touched = false;
    const fs: GalleryFsLike = { mkdir: () => { touched = true; return Promise.resolve(); }, writeNew: () => { touched = true; return Promise.resolve(); } };
    expect(await codeOfError(createGalleryHost({ fs, picturesDir: 'X:\\Pictures' }).save(name, BYTES))).toBe('invalid-argument');
    expect(touched).toBe(false);
    expect(GALLERY_FILE_NAME.test(name)).toBe(false);
  });

  it('accepts exactly the names the app generates', () => {
    for (const name of [NAME, 'InspectorHub-20261102-235959-Z.png', 'InspectorHub-20261102-000000-0123456789abcdef.heic', 'InspectorHub-20261102-101500-ab12cd34.webp']) {
      expect(GALLERY_FILE_NAME.test(name), name).toBe(true);
    }
  });
});
