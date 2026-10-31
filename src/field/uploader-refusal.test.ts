import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { MediaError } from '../media/errors';
import { sniffMediaKind } from '../media/media-types';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { reply, scriptedApi } from './test-support/scripted-api';
import { createUploaderWorld, type UploaderWorld } from './test-support/uploader-world';
import { createUploaderFactory } from './uploader';

const photo = (pendingId: string, blob: Blob): PendingMediaRecord => ({ ...photoRecord(pendingId), blob });
const pad = (head: number[]): Uint8Array => new Uint8Array([...head, ...new Array<number>(Math.max(0, 24 - head.length)).fill(7)]);
const PNG = pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = pad([0xff, 0xd8, 0xff, 0xe0]);
// A box of 24 bytes: size, 'ftyp', major brand 'heic', minor version, one compatible brand.
const HEIC = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0, 0x6d, 0x69, 0x66, 0x31, 0, 0, 0, 0]);
const TEXT = new TextEncoder().encode('this is just some text, not a picture at all');
const blobOf = (bytes: Uint8Array, type: string): Blob => new Blob([new Uint8Array(bytes)], { type });

/**
 * The desktop main process stores a photo under the extension of its declared type and refuses bytes that do not match
 * it. The fake store does not, so this wrapper behaves like the real pair: a mismatch is a failed write.
 */
function withMainProcessGuard(w: UploaderWorld): ReturnType<typeof createUploaderFactory> {
  const mismatch = async (blob: Blob): Promise<boolean> => {
    const kind = sniffMediaKind(new Uint8Array(await blob.slice(0, 4096).arrayBuffer()));
    return `image/${kind ?? 'none'}` !== blob.type;
  };
  const store = {
    ...w.world.store,
    getRow: (id: string) => w.world.store.getRow(id),
    delete: (id: string) => w.world.store.delete(id),
    put: async (rec: PendingMediaRecord) => {
      if (await mismatch(rec.blob)) throw new MediaError('WRITE_FAILED');
      return w.world.store.put(rec);
    },
  };
  return createUploaderFactory({ ...w.deps, store });
}

const directApi = () => scriptedApi(reply(200, { data: { key: 'direct-key' } }));

describe('a valid photo with a wrong declared type is kept under its real type', () => {
  it.each([
    ['a PNG named photo.jpg', PNG, 'image/jpeg', 'image/png'],
    ['a HEIC declared as a JPEG', HEIC, 'image/jpeg', 'image/heic'],
    ['a JPEG declared as a PNG', JPEG, 'image/png', 'image/jpeg'],
    ['a PNG with no declared type', PNG, '', 'image/png'],
  ])('%s', async (_name, bytes, declared, real) => {
    const w = await createUploaderWorld({ api: directApi() });
    const factory = withMainProcessGuard(w);
    // The background upload fails after the write so the row stays to be read back; the write itself is what is under test.
    w.plugin.defaultBehavior = { kind: 'fail' };
    const result = await factory(INSPECTION, null).upload(photo('p1', blobOf(bytes, declared)));
    expect(result).toMatchObject({ ok: false, kept: true });
    expect(result).not.toHaveProperty('permanent');
    expect((await w.world.store.listRows()).map((row) => [row.pendingId, row.contentType])).toEqual([['p1', real]]);
    expect(w.api.calls).toEqual([]);
  });

  it('control: a photo whose type already matches is stored as it is', async () => {
    const w = await createUploaderWorld({ api: directApi() });
    w.plugin.defaultBehavior = { kind: 'fail' };
    await withMainProcessGuard(w)(INSPECTION, null).upload(photo('p1', blobOf(PNG, 'image/png')));
    expect((await w.world.store.listRows()).map((row) => row.contentType)).toEqual(['image/png']);
  });
});

describe('only the type decision itself is permanent', () => {
  it('bytes that are no supported image, with a failed write, still get the one direct upload (the server decides)', async () => {
    const w = await createUploaderWorld({ api: directApi() });
    w.world.files.failWrites();
    const result = await w.factory(INSPECTION, null).upload(photo('p1', blobOf(TEXT, 'image/jpeg')));
    expect(result).toStrictEqual({ ok: true, key: 'direct-key' });
    expect(w.api.calls).toHaveLength(1);
  });

  it('a disk failure on a valid photo is not permanent', async () => {
    const w = await createUploaderWorld({ api: scriptedApi(reply(500, {})) });
    w.world.files.failWrites();
    const result = await w.factory(INSPECTION, null).upload(photo('p1', blobOf(PNG, 'image/jpeg')));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('permanent');
  });

  it('text bytes declared as text are refused permanently by the store, with no network call and no row', async () => {
    const w = await createUploaderWorld({ api: directApi() });
    const result = await w.factory(INSPECTION, null).upload(photo('p1', blobOf(TEXT, 'text/plain')));
    expect(result).toStrictEqual({ ok: false, error: 'UNSUPPORTED_TYPE', permanent: true });
    expect(w.api.calls).toEqual([]);
    expect(w.nativeCalls).toEqual([]);
    expect(await w.world.store.listRows()).toEqual([]);
  });
});

describe('the app sniffer against the editor package sniffer (sniffPhotoType, not exported)', () => {
  // The editor's check is `sniffPhotoType` in field-ui `shared/media-sniff.ts` (read there, 64 bytes). Where the two differ the
  // app's answer is the stricter or equal one, and the outcome is safe: a photo the editor admits that the app cannot
  // classify is not retyped, so it goes down the old path (store as declared; if the desktop guard refuses it, the one
  // direct upload, where the server's own sniffer decides). Nothing is dropped as permanent on the app's say-so alone.
  const box = (size: number, major: string, ...compatible: string[]): Uint8Array => {
    const out = new Uint8Array(Math.max(size, 16 + compatible.length * 4, 12));
    out.set([(size >>> 24) & 255, (size >>> 16) & 255, (size >>> 8) & 255, size & 255], 0);
    out.set(new TextEncoder().encode('ftyp' + major), 4);
    compatible.forEach((brand, i) => out.set(new TextEncoder().encode(brand), 16 + i * 4));
    return out;
  };
  it.each<[string, Uint8Array, string | null, string | null]>([
    // [name, bytes, app answer, editor answer]
    ['jpeg', JPEG, 'jpeg', 'jpeg'],
    ['png', PNG, 'png', 'png'],
    ['heic major brand', box(24, 'heic', 'mif1'), 'heic', 'heic'],
    ['avif major brand', box(24, 'avif', 'mif1'), null, null],
    ['heic major with an avif compatible brand', box(24, 'heic', 'avif'), null, 'heic'],
    ['heic with a 12-byte ftyp box', box(12, 'heic'), null, 'heic'],
    ['text', TEXT, null, null],
  ])('%s', (_name, bytes, app) => {
    expect(sniffMediaKind(bytes)).toBe(app);
  });
});
