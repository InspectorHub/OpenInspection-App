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

  it('ignores the optional size hint: the device keeps one copy of a photo, so thumb, view and original answer alike', () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[KEY, LOCAL]]);
    const photo = createPhotoUrls({ tenantId: TENANT, index });
    for (const size of ['thumb', 'view', 'original'] as const) expect(photo(INSPECTION, KEY, size)).toBe(LOCAL);
    // Control: a hint does not unlock a photo that is not cached or not this account's.
    expect(photo(INSPECTION, `other/inspections/${INSPECTION}/photos/p1.jpg`, 'original')).toBe(PHOTO_PLACEHOLDER_URL);
    expect(photo(INSPECTION, `${TENANT}/inspections/${INSPECTION}/photos/p9.jpg`, 'thumb')).toBe(PHOTO_PLACEHOLDER_URL);
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

  it('indexes only uploaded rows that name a server key, whatever the store hands back', async () => {
    const row = (pendingId: string, state: 'pending' | 'uploaded', uploadedKey: string | null) => ({ pendingId, inspectionId: INSPECTION, kind: 'photo' as const, path: `media/${pendingId}.jpg`, contentType: 'image/jpeg' as const, meta: '{}', state, attempts: 0, uploadedKey, createdAt: 1 });
    const rows = [row('pend', 'pending', KEY), row('nokey', 'uploaded', null), row('good', 'uploaded', `${TENANT}/inspections/${INSPECTION}/photos/good.jpg`)];
    const index = createMemoryPhotoIndex();
    const indexed = await indexUploadedRows(index, { listRows: () => Promise.resolve(rows), objectUrl: (id) => Promise.resolve(`http://localhost/${id}.jpg`) }, INSPECTION);
    expect(indexed).toBe(1);
    expect(index.lookup(INSPECTION, KEY)).toBeNull();
    expect(index.lookup(INSPECTION, `${TENANT}/inspections/${INSPECTION}/photos/good.jpg`)).toBe('http://localhost/good.jpg');
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

describe('photos that are only on the server', () => {
  const stub = (answer: string | null) => {
    const asked: [string, string, string][] = [];
    return { asked, cache: { lookup: (inspectionId: string, key: string, size: string) => (asked.push([inspectionId, key, size]), answer) } };
  };

  it('without a local copy the cache is asked, in the size the caller needs (no hint: the original)', () => {
    const { asked, cache } = stub(`${LOCAL}?cached`);
    const photo = createPhotoUrls({ tenantId: TENANT, index: createMemoryPhotoIndex(), cache });
    expect(photo(INSPECTION, KEY, 'thumb')).toBe(`${LOCAL}?cached`);
    photo(INSPECTION, KEY, 'view');
    photo(INSPECTION, KEY);
    expect(asked.map((a) => a[2])).toEqual(['thumb', 'view', 'original']);
  });

  it('a placeholder while the cache has nothing yet', () => {
    const photo = createPhotoUrls({ tenantId: TENANT, index: createMemoryPhotoIndex(), cache: stub(null).cache });
    expect(photo(INSPECTION, KEY, 'thumb')).toBe(PHOTO_PLACEHOLDER_URL);
  });

  it('a photo with a local copy never asks the cache (control for the test above)', () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[KEY, LOCAL]]);
    const { asked, cache } = stub('http://localhost/other.jpg');
    expect(createPhotoUrls({ tenantId: TENANT, index, cache })(INSPECTION, KEY, 'thumb')).toBe(LOCAL);
    expect(asked).toEqual([]);
  });

  it('a key that is not under this account and inspection never reaches the cache', () => {
    const { asked, cache } = stub('http://localhost/x.jpg');
    const photo = createPhotoUrls({ tenantId: TENANT, index: createMemoryPhotoIndex(), cache });
    for (const key of ['tenant-2/inspections/insp-1/photos/p1.jpg', `${TENANT}/inspections/insp-2/photos/p1.jpg`, '../x', `${KEY}?token=abc`]) {
      expect(photo(INSPECTION, key, 'thumb'), key).toBe(PHOTO_PLACEHOLDER_URL);
    }
    expect(asked).toEqual([]);
  });
});

describe('which addresses the index keeps, per platform', () => {
  const key = (n: string): string => `${TENANT}/inspections/${INSPECTION}/photos/${n}.jpg`;

  it('desktop: the shell media address of a file in its media folder is local', () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[key('a'), 'oi-media://media/photo-cache/abc.webp'], [key('b'), 'oi-media://media/media/p1.jpg']]);
    expect(index.lookup(INSPECTION, key('a'))).toBe('oi-media://media/photo-cache/abc.webp');
    expect(index.lookup(INSPECTION, key('b'))).toBe('oi-media://media/media/p1.jpg');
  });

  it('desktop: that scheme with another host or a credential is not local', () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [[key('a'), 'oi-media://evil/x.jpg'], [key('b'), 'oi-media://u:p@media/x.jpg'], [key('c'), 'oi-media://media/x.jpg?token=1']]);
    for (const n of ['a', 'b', 'c']) expect(index.lookup(INSPECTION, key(n)), n).toBeNull();
  });

  it('android and ios: the web view file addresses stay local, and a remote address still is not', () => {
    const index = createMemoryPhotoIndex();
    index.set(INSPECTION, [
      [key('a'), 'https://localhost/_capacitor_file_/photo-cache/abc.jpg'],
      [key('b'), 'http://localhost/_capacitor_file_/media/p1.jpg'],
      [key('c'), 'capacitor://localhost/_capacitor_file_/media/p1.jpg'],
      [key('d'), 'https://app.example.com/photo-cache/abc.jpg'],
    ]);
    for (const n of ['a', 'b', 'c']) expect(index.lookup(INSPECTION, key(n)), n).not.toBeNull();
    expect(index.lookup(INSPECTION, key('d'))).toBeNull();
  });
});
