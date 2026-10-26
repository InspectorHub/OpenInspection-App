import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { appendPendingInDoc, hasPendingEntryInDoc } from './pending-doc-append';
import { resolvePendingInDoc } from './pending-doc';

const FK = '_default:s1:i1';

const results = (doc: Y.Doc): Y.Map<unknown> => doc.getMap<unknown>('results');
const item = (doc: Y.Doc, key = FK): Y.Map<unknown> => results(doc).get(key) as Y.Map<unknown>;
const photosOf = (doc: Y.Doc, key = FK): Record<string, unknown>[] =>
  (item(doc, key).get('photos') as Y.Array<Y.Map<unknown>>).toArray().map((entry) => entry.toJSON() as Record<string, unknown>);

const PENDING = (pendingId: string) => ({ key: '', pendingUpload: true, pendingId, pendingKind: 'photo', mediaType: 'photo' });

describe('appendPendingInDoc', () => {
  it('seeds an empty document with the full item shape of the editor package and one pending entry', () => {
    const doc = new Y.Doc();
    expect(appendPendingInDoc(doc, FK, 'i1', 'p1')).toBe('appended');
    expect(results(doc).size).toBe(1);
    const map = item(doc);
    expect(map).toBeInstanceOf(Y.Map);
    expect(map.toJSON()).toEqual({
      attributes: {},
      tabs: { information: [], limitations: [], defects: [] },
      photos: [PENDING('p1')],
      recommendations: [],
      customComments: { information: [], limitations: [], defects: [] },
    });
    expect(map.get('attributes')).toBeInstanceOf(Y.Map);
    expect(map.get('tabs')).toBeInstanceOf(Y.Map);
    expect(map.get('photos')).toBeInstanceOf(Y.Array);
    expect(map.get('recommendations')).toBeInstanceOf(Y.Array);
    expect(map.get('customComments')).toBeInstanceOf(Y.Map);
    for (const tab of ['information', 'limitations', 'defects']) {
      expect((map.get('tabs') as Y.Map<unknown>).get(tab)).toBeInstanceOf(Y.Array);
      expect((map.get('customComments') as Y.Map<unknown>).get(tab)).toBeInstanceOf(Y.Array);
    }
    expect((map.get('photos') as Y.Array<unknown>).get(0)).toBeInstanceOf(Y.Map);
  });

  it('the same pending id twice leaves one entry', () => {
    const doc = new Y.Doc();
    expect(appendPendingInDoc(doc, FK, 'i1', 'p1')).toBe('appended');
    expect(appendPendingInDoc(doc, FK, 'i1', 'p1')).toBe('already');
    expect(photosOf(doc)).toEqual([PENDING('p1')]);
  });

  it('two different pending ids leave two entries, in order, and an empty key does not merge them', () => {
    const doc = new Y.Doc();
    appendPendingInDoc(doc, FK, 'i1', 'p1');
    appendPendingInDoc(doc, FK, 'i1', 'p2');
    expect(photosOf(doc)).toEqual([PENDING('p1'), PENDING('p2')]);
  });

  it.each([
    ['not three parts', 'i1', 'i1'],
    ['two parts', 's1:i1', 'i1'],
    ['four parts', '_default:s1:i1:x', 'x'],
    ['an empty part', '_default::i1', 'i1'],
    ['an empty last part', '_default:s1:', ''],
    ['a meta key', '_inspector_signature', '_inspector_signature'],
    ['a meta key with a colon', '_meta:sig', 'sig'],
    ['a last part that is not the item', '_default:s1:i2', 'i1'],
    ['an over-long key', `u:s:${'x'.repeat(520)}`, 'x'.repeat(520)],
  ])('writes nothing for %s', (_name, findingKey, itemId) => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on('update', () => {
      updates += 1;
    });
    expect(appendPendingInDoc(doc, findingKey, itemId, 'p1')).toBe('invalid_key');
    expect(results(doc).size).toBe(0);
    expect(updates).toBe(0);
  });

  it('writes nothing for an empty pending id', () => {
    const doc = new Y.Doc();
    expect(appendPendingInDoc(doc, FK, 'i1', '')).toBe('invalid_key');
    expect(results(doc).size).toBe(0);
  });

  it('accepts a key of a named unit', () => {
    const doc = new Y.Doc();
    expect(appendPendingInDoc(doc, 'u1:s1:i1', 'i1', 'p1')).toBe('appended');
    expect(photosOf(doc, 'u1:s1:i1')).toEqual([PENDING('p1')]);
  });

  it('leaves an item that already has entries otherwise unchanged', () => {
    const doc = new Y.Doc();
    appendPendingInDoc(doc, FK, 'i1', 'p1');
    doc.transact(() => {
      const map = item(doc);
      map.set('notes', 'Cracked flashing');
      map.set('rating', 'D');
      const tabs = map.get('tabs') as Y.Map<unknown>;
      const defects = tabs.get('defects') as Y.Array<unknown>;
      const canned = new Y.Map<unknown>();
      canned.set('id', 'c1');
      defects.push([canned]);
      (map.get('photos') as Y.Array<Y.Map<unknown>>).get(0).set('caption', 'roof');
    });
    const before = item(doc).toJSON() as Record<string, unknown>;
    const other = new Y.Doc();
    appendPendingInDoc(other, '_default:s1:i2', 'i2', 'q1');
    const otherBefore = item(other, '_default:s1:i2').toJSON();
    appendPendingInDoc(doc, FK, 'i1', 'p2');
    const after = item(doc).toJSON() as Record<string, unknown> & { photos: unknown[] };
    expect(after.photos).toEqual([{ ...PENDING('p1'), caption: 'roof' }, PENDING('p2')]);
    expect({ ...after, photos: [] }).toEqual({ ...before, photos: [] });
    expect(after.notes).toBe('Cracked flashing');
    expect(otherBefore).toEqual(item(other, '_default:s1:i2').toJSON());
  });

  it('does not touch a sibling item', () => {
    const doc = new Y.Doc();
    appendPendingInDoc(doc, '_default:s1:i2', 'i2', 'q1');
    const sibling = item(doc, '_default:s1:i2').toJSON();
    appendPendingInDoc(doc, FK, 'i1', 'p1');
    expect(item(doc, '_default:s1:i2').toJSON()).toEqual(sibling);
    expect(results(doc).size).toBe(2);
  });

  it('repairs an item whose photos array is missing instead of throwing', () => {
    const doc = new Y.Doc();
    results(doc).set(FK, new Y.Map<unknown>());
    expect(appendPendingInDoc(doc, FK, 'i1', 'p1')).toBe('appended');
    expect(photosOf(doc)).toEqual([PENDING('p1')]);
  });
});

describe('appendPendingInDoc then resolvePendingInDoc', () => {
  it('the entry it writes is the one the resolver swaps for the uploaded key, in place', () => {
    const doc = new Y.Doc();
    expect(appendPendingInDoc(doc, FK, 'i1', 'p1')).toBe('appended');
    expect(appendPendingInDoc(doc, FK, 'i1', 'p2')).toBe('appended');
    const key = 'tenant-1/inspections/insp-1/photos/p1.jpg';
    expect(resolvePendingInDoc(doc, 'p1', key)).toBe('resolved');
    expect(photosOf(doc)).toEqual([{ key, mediaType: 'photo' }, PENDING('p2')]);
    // The second resolution finds the key already there and no pending entry for it.
    expect(resolvePendingInDoc(doc, 'p1', key)).toBe('already');
    // Control: an id nobody appended is missing, not resolved.
    expect(resolvePendingInDoc(doc, 'ghost', 'tenant-1/inspections/insp-1/photos/ghost.jpg')).toBe('missing');
  });
});

describe('hasPendingEntryInDoc', () => {
  it('finds an appended entry and never writes', () => {
    const doc = new Y.Doc();
    expect(hasPendingEntryInDoc(doc, FK, 'i1', 'p1')).toBe(false);
    expect(doc.getMap('results').size).toBe(0);
    appendPendingInDoc(doc, FK, 'i1', 'p1');
    expect(hasPendingEntryInDoc(doc, FK, 'i1', 'p1')).toBe(true);
    expect(hasPendingEntryInDoc(doc, FK, 'i1', 'p2')).toBe(false);
    expect(hasPendingEntryInDoc(doc, '_default:s1:other', 'i1', 'p1')).toBe(false);
  });
});
