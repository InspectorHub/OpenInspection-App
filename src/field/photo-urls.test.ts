import { describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createMediaStore } from '../media/store';
import { createMediaWorld, INSPECTION, photoRecord } from '../media/test-support/fakes';
import { createMemoryPhotoIndex, createPhotoUrls, indexUploadedRows, isPhotoPlaceholder, PHOTO_PLACEHOLDER_URL } from './photo-urls';

const TENANT = 'tenant-1';
const KEY = `${TENANT}/inspections/${INSPECTION}/photos/p1.jpg`;
const LOCAL = 'http://localhost/_capacitor_file_/media/p1.jpg';

describe('photo urls', () => {
  it('answers the local address of a cached photo, synchronously', () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[KEY, LOCAL]]);
    const photo = createPhotoUrls({ tenantId: TENANT, index });
    expect(photo(INSPECTION, KEY)).toBe(LOCAL);
  });

  it('answers the marked placeholder for a photo that is not cached, never a server address', () => {
    const photo = createPhotoUrls({ tenantId: TENANT, index: createMemoryPhotoIndex() });
    const url = photo(INSPECTION, KEY);
    expect(url).toBe(PHOTO_PLACEHOLDER_URL);
    expect(isPhotoPlaceholder(url)).toBe(true);
    expect(isPhotoPlaceholder(LOCAL)).toBe(false);
    expect(url).not.toContain('/api/');
    expect(url).not.toMatch(/token|key=/i);
  });

  it('refuses a key that is not under this account and inspection, even when it is cached', () => {
    const index = createMemoryPhotoIndex();
    const foreignTenant = 'tenant-2/inspections/insp-1/photos/p1.jpg';
    const otherInspection = `${TENANT}/inspections/insp-2/photos/p1.jpg`;
    const sibling = `${TENANT}/inspections/${INSPECTION}-x/photos/p1.jpg`;
    index.set(INSPECTION, [[foreignTenant, LOCAL], [otherInspection, LOCAL], [sibling, LOCAL], [KEY, LOCAL]]);
    const photo = createPhotoUrls({ tenantId: TENANT, index });
    for (const key of [foreignTenant, otherInspection, sibling, '', '../x', `${TENANT}/inspections/${INSPECTION}/../../tenant-2/x.jpg`, `${KEY}?token=abc`, `${KEY}#frag`]) {
      expect(photo(INSPECTION, key), key).toBe(PHOTO_PLACEHOLDER_URL);
    }
    // Control: the same cached address is handed out for the key that does belong here.
    expect(photo(INSPECTION, KEY)).toBe(LOCAL);
  });

  it("an inspection's cache is not another inspection's: the same key asked under another id is the placeholder", () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[KEY, LOCAL]]);
    const photo = createPhotoUrls({ tenantId: TENANT, index });
    expect(photo('insp-2', KEY)).toBe(PHOTO_PLACEHOLDER_URL);
    expect(photo(INSPECTION, KEY)).toBe(LOCAL);
  });
});

describe('the memory index', () => {
  it('never keeps an address that carries a credential or leaves the device', () => {
    const index = createMemoryPhotoIndex();
    const good = `${TENANT}/inspections/${INSPECTION}/photos/good.jpg`;
    const entries: [string, string][] = [
      [`${TENANT}/inspections/${INSPECTION}/photos/a.jpg`, 'https://app.example.com/api/inspections/i/photo?key=a&token=secret'],
      [`${TENANT}/inspections/${INSPECTION}/photos/b.jpg`, 'http://localhost/photo.jpg?access_token=secret'],
      [`${TENANT}/inspections/${INSPECTION}/photos/c.jpg`, 'https://user:pass@localhost/photo.jpg'],
      [`${TENANT}/inspections/${INSPECTION}/photos/d.jpg`, 'https://cdn.example.com/photo.jpg'],
      [`${TENANT}/inspections/${INSPECTION}/photos/e.jpg`, 'javascript:alert(1)'],
      [`${TENANT}/inspections/${INSPECTION}/photos/f.jpg`, 'not a url'],
      [good, 'capacitor://localhost/_capacitor_file_/media/good.jpg'],
    ];
    index.set(INSPECTION, entries);
    for (const [key] of entries.slice(0, 6)) expect(index.lookup(INSPECTION, key), key).toBeNull();
    expect(index.lookup(INSPECTION, good)).toBe('capacitor://localhost/_capacitor_file_/media/good.jpg');
  });

  it('forgets one inspection or all of them', () => {
    const index = createMemoryPhotoIndex();
    const other = `${TENANT}/inspections/insp-2/photos/q.jpg`;
    index.set(INSPECTION, [[KEY, LOCAL]]);
    index.set('insp-2', [[other, LOCAL]]);
    index.clear(INSPECTION);
    expect(index.lookup(INSPECTION, KEY)).toBeNull();
    expect(index.lookup('insp-2', other)).toBe(LOCAL);
    index.clear();
    expect(index.lookup('insp-2', other)).toBeNull();
  });

  it('set replaces what the inspection had', () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[KEY, LOCAL]]);
    index.set(INSPECTION, []);
    expect(index.lookup(INSPECTION, KEY)).toBeNull();
  });
});

describe('indexUploadedRows', () => {
  it('maps the key an uploaded row now has on the server to the file still on the device', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('p1'));
    await world.store.put(photoRecord('p2'));
    await world.store.markState('p1', 'uploaded', { attempts: 0, uploadedKey: KEY });
    const index = createMemoryPhotoIndex();
    expect(await indexUploadedRows(index, world.store, INSPECTION)).toBe(1);
    expect(index.lookup(INSPECTION, KEY)).toBe(await world.store.objectUrl('p1'));
    expect(index.lookup(INSPECTION, KEY)).not.toBeNull();
  });

  it('a pending row has no server key yet, so nothing is indexed for it', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('p1'));
    const index = createMemoryPhotoIndex();
    expect(await indexUploadedRows(index, world.store, INSPECTION)).toBe(0);
  });

  it('a store that cannot be read leaves the index as it was and does not throw', async () => {
    const files = createMemoryFiles();
    const world = await createMediaWorld();
    const broken = { ...createMediaStore({ db: world.db, files, isBlocked: () => Promise.resolve(false) }), listRows: () => Promise.reject(new Error('db')) };
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[KEY, LOCAL]]);
    expect(await indexUploadedRows(index, broken, INSPECTION)).toBe(0);
    expect(index.lookup(INSPECTION, KEY)).toBe(LOCAL);
  });
});
