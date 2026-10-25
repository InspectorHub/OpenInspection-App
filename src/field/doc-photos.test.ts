import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { findPhotoIndex, pendingIdsInDoc } from './doc-photos';
import { seedPhotos } from './test-support/doc-seed';

describe('findPhotoIndex', () => {
  it('finds the current position of a key and follows it when photos are added before it', () => {
    const doc = new Y.Doc();
    seedPhotos(doc, '_default:s1:i1', [{ key: 'a' }, { key: 'b' }]);
    expect(findPhotoIndex(doc, '_default:s1:i1', 'b')).toBe(1);
    const photos = (doc.getMap<unknown>('results').get('_default:s1:i1') as Y.Map<unknown>).get('photos') as Y.Array<unknown>;
    const added = new Y.Map<unknown>();
    added.set('key', 'z');
    photos.insert(0, [added]);
    expect(findPhotoIndex(doc, '_default:s1:i1', 'b')).toBe(2);
  });

  it('answers -1 for a missing photo, a missing item, and a photo that lives under another item', () => {
    const doc = new Y.Doc();
    seedPhotos(doc, 'k1', [{ key: 'a' }]);
    seedPhotos(doc, 'k2', [{ key: 'other' }]);
    expect(findPhotoIndex(doc, 'k1', 'gone')).toBe(-1);
    expect(findPhotoIndex(doc, 'nope', 'a')).toBe(-1);
    expect(findPhotoIndex(doc, 'k1', 'other')).toBe(-1);
    expect(findPhotoIndex(doc, 'k2', 'other')).toBe(0);
  });
});

describe('pendingIdsInDoc', () => {
  it('lists every entry that names a local record, of any pending kind, under any item', () => {
    const doc = new Y.Doc();
    seedPhotos(doc, 'k1', [{ key: '', pendingUpload: true, pendingId: 'p1', pendingKind: 'photo' }, { key: 'real' }]);
    seedPhotos(doc, 'k2', [{ key: 'base', pendingId: 'p2', pendingKind: 'crop' }]);
    expect([...pendingIdsInDoc(doc)].sort()).toEqual(['p1', 'p2']);
  });

  it('is empty for an empty document and ignores an empty id', () => {
    const doc = new Y.Doc();
    expect(pendingIdsInDoc(doc).size).toBe(0);
    seedPhotos(doc, 'k1', [{ key: 'a', pendingId: '' }]);
    expect(pendingIdsInDoc(doc).size).toBe(0);
  });
});
