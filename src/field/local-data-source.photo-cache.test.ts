import { describe, expect, it } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { INSPECTION, photoRecord } from '../media/test-support/fakes';
import { createPhotoCache } from './photo-cache';
import { PHOTO_PLACEHOLDER_URL, createUploadedCopyReader } from './photo-urls';
import { reply, scriptedApi } from './test-support/scripted-api';
import { world } from './test-support/data-source-world';

const TENANT = 'tenant-1';
const KEY = `${TENANT}/inspections/${INSPECTION}/photos/p1.jpg`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** The editor's data source over a photo cache on the same database and files, on the Android platform. */
async function withCache(online = true) {
  const api = scriptedApi();
  api.send = (call) => {
    api.calls.push(call);
    return Promise.resolve({ ...reply(200), bytes: JPEG, contentType: 'image/jpeg' });
  };
  const timers = createManualTimers();
  const boot = await world({ api, platform: 'android', network: { isOnline: () => online, onOnlineChange: () => () => undefined } });
  const photoCache = createPhotoCache({
    db: boot.db,
    files: boot.files,
    api,
    account: boot.stack.account,
    network: { ready: Promise.resolve(), isOnline: () => online, onOnlineChange: () => () => undefined },
    clock: { now: () => 5_000 },
    timers,
    localCopy: createUploadedCopyReader(boot.store, boot.files),
  });
  const w = await world({ api, platform: 'android', photoCache, files: boot.files, network: { isOnline: () => online, onOnlineChange: () => () => undefined } });
  return { w, api, timers, boot };
}

describe('the editor data source with a photo cache (non-desktop: web view file addresses)', () => {
  it('shows the placeholder, then a device address after the download, and tells the editor to ask again', async () => {
    const { w, api, timers } = await withCache();
    let heard = 0;
    const unsubscribe = w.source.urls.subscribe?.(() => void (heard += 1));
    expect(typeof unsubscribe).toBe('function');
    expect(w.source.urls.photo(INSPECTION, KEY, 'thumb')).toBe(PHOTO_PLACEHOLDER_URL);
    await settle();
    while (timers.pending() > 0) timers.fireNext();
    expect(heard).toBe(1);
    expect(api.calls.filter((c) => c.path.endsWith('/photo'))).toHaveLength(1);
    const url = w.source.urls.photo(INSPECTION, KEY, 'thumb');
    expect(url).toMatch(/^https:\/\/localhost\/_capacitor_file_\/photo-cache\//);
  });

  it('a key from another account sends nothing', async () => {
    const { w, api } = await withCache();
    expect(w.source.urls.photo(INSPECTION, `tenant-2/inspections/${INSPECTION}/photos/p1.jpg`, 'thumb')).toBe(PHOTO_PLACEHOLDER_URL);
    await settle();
    expect(api.calls.filter((c) => c.path.endsWith('/photo'))).toHaveLength(0);
  });

  it('a photo uploaded a moment ago is taken from its own file: no request, and it keeps showing after that file is deleted', async () => {
    const { w, api, timers, boot } = await withCache();
    await boot.store.put(photoRecord('p1'));
    // The test double's bytes are not a real picture; the cache only adopts bytes that are one.
    await boot.files.write('media/p1.jpg', JPEG);
    await boot.store.markState('p1', 'uploaded', { attempts: 0, uploadedKey: KEY });
    expect(w.source.urls.photo(INSPECTION, KEY, 'thumb')).toBe(PHOTO_PLACEHOLDER_URL);
    await settle();
    while (timers.pending() > 0) timers.fireNext();
    const url = w.source.urls.photo(INSPECTION, KEY, 'thumb');
    expect(url).toMatch(/photo-cache\//);
    expect(api.calls.filter((c) => c.path.endsWith('/photo'))).toHaveLength(0);
    for (const row of await boot.store.listRows({ inspectionId: INSPECTION })) await boot.files.remove(row.path);
    expect(w.source.urls.photo(INSPECTION, KEY, 'thumb')).toBe(url);
  });

  it('real order: uploaded, indexed at open, the local file then deleted by cleanup: the key still resolves to a cache copy, never a placeholder', async () => {
    const { boot } = await withCache();
    await boot.store.put(photoRecord('p1'));
    await boot.files.write('media/p1.jpg', JPEG);
    await boot.store.markState('p1', 'uploaded', { attempts: 0, uploadedKey: KEY });
    const cache = createPhotoCache({
      db: boot.db,
      files: boot.files,
      api: scriptedApi(),
      account: boot.stack.account,
      network: { ready: Promise.resolve(), isOnline: () => true, onOnlineChange: () => () => undefined },
      clock: { now: () => 5_000 },
      timers: createManualTimers(),
      localCopy: createUploadedCopyReader(boot.store, boot.files),
    });
    const source = (await world({ platform: 'android', photoCache: cache, files: boot.files, stack: boot.stack })).source;
    await source.load(INSPECTION);
    for (const row of await boot.store.listRows({ inspectionId: INSPECTION })) await boot.files.remove(row.path);
    const url = source.urls.photo(INSPECTION, KEY, 'thumb');
    expect(url).not.toBe(PHOTO_PLACEHOLDER_URL);
    expect(url).toMatch(/photo-cache\//);
  });

  it('a local original the cache cannot hold (HEIC) is still shown from its file', async () => {
    const { boot } = await withCache();
    await boot.store.put(photoRecord('h1'));
    await boot.files.write('media/h1.jpg', new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0]));
    await boot.store.markState('h1', 'uploaded', { attempts: 0, uploadedKey: KEY });
    const cache = createPhotoCache({
      db: boot.db,
      files: boot.files,
      api: scriptedApi(),
      account: boot.stack.account,
      network: { ready: Promise.resolve(), isOnline: () => true, onOnlineChange: () => () => undefined },
      clock: { now: () => 5_000 },
      timers: createManualTimers(),
      localCopy: createUploadedCopyReader(boot.store, boot.files),
    });
    const source = (await world({ platform: 'android', photoCache: cache, files: boot.files, stack: boot.stack })).source;
    await source.load(INSPECTION);
    const url = source.urls.photo(INSPECTION, KEY, 'thumb');
    expect(url).not.toBe(PHOTO_PLACEHOLDER_URL);
    expect(url).toContain('/media/h1.jpg');
  });

  it('without a cache the data source is as before: no subscribe, and a server-only photo is the placeholder', async () => {
    const w = await world({ platform: 'android' });
    expect(w.source.urls.subscribe).toBeUndefined();
    expect(w.source.urls.photo(INSPECTION, KEY, 'thumb')).toBe(PHOTO_PLACEHOLDER_URL);
  });
});
