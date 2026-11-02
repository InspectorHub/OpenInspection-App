import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { createMemoryKeyValue } from '../platform/kv';
import { createMemoryGallery, type PhotoGallery } from '../platform/photo-gallery';
import { createGalleryCopier, createGallerySetting, galleryFileName, GALLERY_SETTING_KEY, photoSource } from './gallery-copy';

type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;

/** A photo as a later editor version hands it over: with the source it came from. */
const withSource = (source: string | undefined, pendingId = 'p1'): Photo => {
  const base = photoRecord(pendingId) as unknown as Photo;
  return source === undefined ? base : ({ ...base, meta: { ...base.meta, source } } as unknown as Photo);
};

async function rig(on: boolean, options: Parameters<typeof createMemoryGallery>[0] = {}) {
  const kv = createMemoryKeyValue();
  const setting = createGallerySetting(kv);
  if (on) await setting.set(true);
  const gallery = createMemoryGallery(options);
  const results: string[] = [];
  const copy = createGalleryCopier({ setting, gallery, onResult: (result) => results.push(result) });
  return { kv, setting, gallery, results, copy };
}

describe('the setting', () => {
  it('is off until it is turned on, and the choice is kept', async () => {
    const kv = createMemoryKeyValue();
    const setting = createGallerySetting(kv);
    expect(await setting.get()).toBe(false);
    await setting.set(true);
    expect(await createGallerySetting(kv).get()).toBe(true);
    expect(kv.entries()[GALLERY_SETTING_KEY]).toBe('1');
    await setting.set(false);
    expect(await setting.get()).toBe(false);
  });

  it('reads as off when the store cannot be read', async () => {
    const setting = createGallerySetting({ get: () => Promise.reject(new Error('no store')), set: () => Promise.resolve() });
    expect(await setting.get()).toBe(false);
  });
});

describe('copying a photo to the gallery', () => {
  it('saves a photo taken with the camera when the setting is on', async () => {
    const r = await rig(true);
    await r.copy(withSource('camera'));
    expect(r.results).toEqual(['saved']);
    expect(r.gallery.saved).toHaveLength(1);
    expect(r.gallery.saved[0]?.name).toMatch(/^InspectorHub-\d{8}-\d{6}-p1\.jpg$/);
  });

  it('saves a burst-camera frame too', async () => {
    const r = await rig(true);
    await r.copy(withSource('burst'));
    expect(r.gallery.saved).toHaveLength(1);
  });

  it('control: with the setting off (the default) nothing is saved', async () => {
    const r = await rig(false);
    await r.copy(withSource('camera'));
    expect(r.results).toEqual(['skipped']);
    expect(r.gallery.saved).toEqual([]);
  });

  it('a photo picked from the library is not saved again (it is already in the gallery)', async () => {
    const r = await rig(true);
    await r.copy(withSource('library'));
    expect(r.results).toEqual(['skipped']);
    expect(r.gallery.saved).toEqual([]);
  });

  it('a photo whose source the editor did not state is not saved: fewer copies, never a duplicate of a library photo', async () => {
    const r = await rig(true);
    await r.copy(withSource(undefined));
    expect(r.gallery.saved).toEqual([]);
    expect(photoSource(withSource(undefined))).toBeNull();
  });

  it('where the build has no way to save, nothing is attempted and the setting is not even read', async () => {
    let reads = 0;
    const gallery: PhotoGallery = { available: () => false, save: () => Promise.reject(new Error('must not be called')) };
    const copy = createGalleryCopier({ setting: { get: () => { reads += 1; return Promise.resolve(true); } }, gallery });
    await copy(withSource('camera'));
    expect(reads).toBe(0);
  });

  it('a refusal by the system is reported as such and does not throw', async () => {
    const r = await rig(true, { result: 'denied' });
    await r.copy(withSource('camera'));
    expect(r.results).toEqual(['denied']);
  });

  it('a gallery that throws, or a setting that throws, never makes the copy throw', async () => {
    const throwing: PhotoGallery = { available: () => true, save: () => Promise.reject(new Error('disk full /secret/path')) };
    const results: string[] = [];
    const copy = createGalleryCopier({ setting: { get: () => Promise.resolve(true) }, gallery: throwing, onResult: (result) => results.push(result) });
    await expect(copy(withSource('camera'))).resolves.toBeUndefined();
    expect(results).toEqual(['failed']);
    const broken = createGalleryCopier({ setting: { get: () => Promise.reject(new Error('x')) }, gallery: createMemoryGallery() });
    await expect(broken(withSource('camera'))).resolves.toBeUndefined();
  });
});

describe('the file name', () => {
  it('holds a time and a piece of the pending id, and nothing about the inspection', () => {
    const rec = { ...withSource('camera', 'a1b2c3d4-e5f6'), createdAt: Date.UTC(2026, 10, 1, 9, 5, 7) } as Photo;
    expect(galleryFileName(rec)).toBe('InspectorHub-20261101-090507-a1b2c3d4.jpg');
    expect(galleryFileName(rec)).not.toContain(INSPECTION);
  });

  it('takes its extension from the photo type', () => {
    const rec = withSource('camera');
    expect(galleryFileName({ ...rec, blob: new Blob([new Uint8Array([1])], { type: 'image/png' }) } as Photo)).toMatch(/\.png$/);
    expect(galleryFileName({ ...rec, blob: new Blob([new Uint8Array([1])], { type: 'image/heic' }) } as Photo)).toMatch(/\.heic$/);
  });
});
