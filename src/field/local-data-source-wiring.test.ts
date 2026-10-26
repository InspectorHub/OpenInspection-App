import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { INSPECTION, jpegBlob, photoRecord } from '../media/test-support/fakes';
import { MESSAGES } from './messages';
import { PHOTO_PLACEHOLDER_URL, createMemoryPhotoIndex } from './photo-urls';
import { world } from './test-support/data-source-world';
import { seedPhotos } from './test-support/doc-seed';

const FINDING = '_default:s1:i1';
const KEY = `tenant-1/inspections/${INSPECTION}/photos/p1.jpg`;

describe('openUrl', () => {
  it('opens the normalised address, so what was checked is what is sent', async () => {
    const w = await world();
    w.source.openUrl?.('HTTPS://Example.com:443/a b?x=1');
    expect(w.opened).toEqual(['https://example.com/a%20b?x=1']);
  });

  it('a browser that throws at once is reported and told to the person, and the editor goes on', async () => {
    const errors: unknown[] = [];
    const w = await world({
      openExternal: () => {
        throw new Error('no browser');
      },
      onError: (error) => errors.push(error),
    });
    expect(() => w.source.openUrl?.('https://example.com')).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(w.notes).toEqual([[MESSAGES.linkNotOpened, 'warning']]);
  });

  it('a browser that refuses later is told to the person too', async () => {
    const w = await world({ openExternal: () => Promise.reject(new Error('no browser')), onError: () => undefined });
    w.source.openUrl?.('https://example.com');
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(w.notes).toEqual([[MESSAGES.linkNotOpened, 'warning']]);
  });
});

describe('what is wired to what', () => {
  it('the photo index is filled by a load of the inspection and not by a load of one scope', async () => {
    const index = createMemoryPhotoIndex();
    const w = await world({ photoIndex: index });
    await w.store.put(photoRecord('p1'));
    await w.store.markState('p1', 'uploaded', { attempts: 0, uploadedKey: KEY });
    await w.source.load(INSPECTION, '_default');
    expect(w.source.urls.photo(INSPECTION, KEY)).toBe(PHOTO_PLACEHOLDER_URL);
    await w.source.load(INSPECTION);
    expect(w.source.urls.photo(INSPECTION, KEY)).not.toBe(PHOTO_PLACEHOLDER_URL);
  });

  it('isOnline follows the link as it changes', async () => {
    const w = await world();
    expect(w.source.isOnline()).toBe(true);
    w.online.value = false;
    expect(w.source.isOnline()).toBe(false);
    w.online.value = true;
    expect(w.source.isOnline()).toBe(true);
  });

  it('a queued crop is read back from the device by the assembled uploader, and sent only while the open document is in step with the server', async () => {
    const w = await world({ photoIndex: createMemoryPhotoIndex() });
    w.api.calls.length = 0;
    const open = w.source.collab.connect(INSPECTION, {});
    seedPhotos(open.doc, FINDING, [{ key: 'photo-b' }]);
    const crop: PendingMediaRecord = {
      kind: 'crop',
      pendingId: 'c1',
      inspectionId: INSPECTION,
      blob: jpegBlob(2),
      createdAt: 1,
      meta: { findingKey: FINDING, itemId: 'i1', photoIndex: 0, photoKey: 'photo-b', crop: { aspect: 'free', orientation: 'landscape', x: 0, y: 0, width: 4, height: 4 } },
    };
    await w.store.put(crop);
    const [listed] = await w.store.list(INSPECTION);
    const uploader = w.source.media.uploader(INSPECTION, open.doc);

    w.sync.value = false;
    expect(await uploader.upload(listed as PendingMediaRecord)).toEqual({ ok: false, error: MESSAGES.waitForSync });
    expect(w.api.calls).toHaveLength(0);

    w.sync.value = true;
    w.api.calls.length = 0;
    const result = await uploader.upload(listed as PendingMediaRecord);
    // The scripted server answers an empty body, which names no key: the request was made, and the answer is not a success.
    expect(result).toEqual({ ok: false, error: MESSAGES.unreadableAnswer });
    expect(w.api.calls).toHaveLength(1);
    const image = w.api.calls[0]?.form?.get('image');
    expect(image instanceof Blob && image.size).toBeGreaterThan(0);
  });

  it('with no open document there is nothing in step with the server: a crop is refused', async () => {
    const w = await world();
    const orphan = new Y.Doc();
    seedPhotos(orphan, FINDING, [{ key: 'photo-b' }]);
    const crop: PendingMediaRecord = {
      kind: 'crop', pendingId: 'c2', inspectionId: INSPECTION, blob: jpegBlob(2), createdAt: 1,
      meta: { findingKey: FINDING, itemId: 'i1', photoIndex: 0, photoKey: 'photo-b', crop: { aspect: 'free', orientation: 'landscape', x: 0, y: 0, width: 4, height: 4 } },
    };
    expect(await w.source.media.uploader(INSPECTION, orphan).upload(crop)).toEqual({ ok: false, error: MESSAGES.waitForSync });
    expect(w.api.calls).toHaveLength(0);
  });
});
