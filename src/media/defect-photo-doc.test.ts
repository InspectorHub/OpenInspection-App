import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { defectPhotosOf, seedDefects } from '../field/test-support/doc-seed';
import { neverBlocked } from '../test-support/never-blocked';
import type { DefectTarget } from './defect-target';
import { createDefectResolver, createWithDoc, resolveDefectInDoc, type DocPorts } from './pending-doc';

const FK = '_default:s1:i1';
const KEY = 'tenant-1/inspections/insp-1/photos/p1.jpg';
const KEY_2 = 'tenant-1/inspections/insp-1/photos/p2.jpg';
const canned = (customId = 'd1'): DefectTarget => ({ findingKey: FK, itemId: 'i1', customId, defectKind: 'canned' });
const custom = (customId = 'd1'): DefectTarget => ({ findingKey: FK, itemId: 'i1', customId, defectKind: 'custom' });

/** Both kinds carry a defect named `d1`, so a mix-up between the two lists shows. */
function docWithDefects(): Y.Doc {
  const doc = new Y.Doc();
  seedDefects(doc, FK, { canned: [{ id: 'd1' }, { id: 'd2', photos: [{ key: 'other-canned' }] }], custom: [{ id: 'd1' }, { id: 'd3', photos: [{ key: 'other-custom' }] }] });
  return doc;
}

describe('resolveDefectInDoc: the key of an uploaded defect photo is added to that defect', () => {
  it('a canned defect gets { key } in its photos and nothing else in the document changes (control: the custom defect of the same id is untouched)', () => {
    const doc = docWithDefects();
    expect(resolveDefectInDoc(doc, canned(), KEY)).toBe('resolved');
    expect(defectPhotosOf(doc, FK, 'canned', 'd1')).toEqual([{ key: KEY }]);
    expect(defectPhotosOf(doc, FK, 'canned', 'd2')).toEqual([{ key: 'other-canned' }]);
    expect(defectPhotosOf(doc, FK, 'custom', 'd1')).toBeUndefined();
    expect(defectPhotosOf(doc, FK, 'custom', 'd3')).toEqual([{ key: 'other-custom' }]);
  });

  it('a custom defect gets { key } in its photos (control: the canned defect of the same id is untouched)', () => {
    const doc = docWithDefects();
    expect(resolveDefectInDoc(doc, custom(), KEY)).toBe('resolved');
    expect(defectPhotosOf(doc, FK, 'custom', 'd1')).toEqual([{ key: KEY }]);
    expect(defectPhotosOf(doc, FK, 'canned', 'd1')).toBeUndefined();
    expect(defectPhotosOf(doc, FK, 'canned', 'd2')).toEqual([{ key: 'other-canned' }]);
  });

  it('the photos already on the defect stay and the new key follows them', () => {
    const doc = new Y.Doc();
    seedDefects(doc, FK, { custom: [{ id: 'd1', photos: [{ key: 'first' }, { key: 'second', note: 'kept' }] }] });
    expect(resolveDefectInDoc(doc, custom(), KEY)).toBe('resolved');
    expect(defectPhotosOf(doc, FK, 'custom', 'd1')).toEqual([{ key: 'first' }, { key: 'second', note: 'kept' }, { key: KEY }]);
  });

  it('a photos list kept as a Y array is read and replaced the same way', () => {
    const doc = new Y.Doc();
    seedDefects(doc, FK, { custom: [{ id: 'd1', photos: [] }] });
    const item = doc.getMap<unknown>('results').get(FK) as Y.Map<unknown>;
    const list = (item.get('customComments') as Y.Map<unknown>).get('defects') as Y.Array<unknown>;
    const defect = list.get(0) as Y.Map<unknown>;
    const photos = new Y.Array<unknown>();
    doc.transact(() => {
      defect.set('photos', photos);
      photos.push([{ key: 'first' }]);
    });
    expect(resolveDefectInDoc(doc, custom(), KEY)).toBe('resolved');
    expect(defectPhotosOf(doc, FK, 'custom', 'd1')).toEqual([{ key: 'first' }, { key: KEY }]);
  });

  it('a key that is already there is "already" and is not added twice (control: another key is added next to it)', () => {
    const doc = docWithDefects();
    expect(resolveDefectInDoc(doc, canned(), KEY)).toBe('resolved');
    expect(resolveDefectInDoc(doc, canned(), KEY)).toBe('already');
    expect(defectPhotosOf(doc, FK, 'canned', 'd1')).toEqual([{ key: KEY }]);
    expect(resolveDefectInDoc(doc, canned(), KEY_2)).toBe('resolved');
    expect(defectPhotosOf(doc, FK, 'canned', 'd1')).toEqual([{ key: KEY }, { key: KEY_2 }]);
  });

  it('a key the editor has already attached (it adds the key of a successful upload itself) is "already", not a second entry', () => {
    const doc = new Y.Doc();
    seedDefects(doc, FK, { custom: [{ id: 'd1', photos: [{ key: KEY }] }] });
    expect(resolveDefectInDoc(doc, custom(), KEY)).toBe('already');
    expect(defectPhotosOf(doc, FK, 'custom', 'd1')).toEqual([{ key: KEY }]);
  });

  describe('when the defect is not in the document nothing is written (the caller keeps the file)', () => {
    const cases: [string, DefectTarget][] = [
      ['a defect id that is not there (canned)', canned('ghost')],
      ['a defect id that is not there (custom)', custom('ghost')],
      ['a canned id that exists only as a custom defect', canned('d3')],
      ['a custom id that exists only as a canned defect', custom('d2')],
      ['an item that is not there', { ...canned(), findingKey: '_default:s1:i9', itemId: 'i9' }],
      ['a finding key that is not an item key', { ...canned(), findingKey: '_inspector_signature' }],
      ['a finding key whose last part is not the item id', { ...canned(), itemId: 'i2' }],
    ];
    it.each(cases)('%s', (_name, target) => {
      const doc = docWithDefects();
      const before = Y.encodeStateAsUpdate(doc);
      expect(resolveDefectInDoc(doc, target, KEY)).toBe('missing');
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect([...doc.getMap<unknown>('results').keys()]).toEqual([FK]);
      // Control: the same document does take the key for a defect that is there.
      expect(resolveDefectInDoc(doc, canned(), KEY)).toBe('resolved');
    });

    it('an item with no defect lists at all', () => {
      const doc = new Y.Doc();
      doc.getMap<unknown>('results').set(FK, new Y.Map<unknown>());
      expect(resolveDefectInDoc(doc, canned(), KEY)).toBe('missing');
      expect(resolveDefectInDoc(doc, custom(), KEY)).toBe('missing');
    });

    it('a photos field that is neither a list nor absent is not overwritten', () => {
      const doc = new Y.Doc();
      seedDefects(doc, FK, { custom: [{ id: 'd1' }] });
      const item = doc.getMap<unknown>('results').get(FK) as Y.Map<unknown>;
      const defect = ((item.get('customComments') as Y.Map<unknown>).get('defects') as Y.Array<unknown>).get(0) as Y.Map<unknown>;
      defect.set('photos', 'not a list');
      expect(resolveDefectInDoc(doc, custom(), KEY)).toBe('missing');
      expect(defect.get('photos')).toBe('not a list');
    });
  });
});

describe('createDefectResolver over a stored document', () => {
  async function database() {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    return db;
  }

  it('attaches the key to a defect of the live document', async () => {
    const live = docWithDefects();
    const withDoc = createWithDoc({ isBlocked: neverBlocked, db: await database(), docs: { isOpen: () => true, liveDoc: () => live } });
    await expect(createDefectResolver({ withDoc })('insp-1', 'p1', KEY, canned())).resolves.toBe('resolved');
    expect(defectPhotosOf(live, FK, 'canned', 'd1')).toEqual([{ key: KEY }]);
  });

  it('a blocked inspection is not written to and the call rejects with BLOCKED (control: the same call on the same document resolves when not blocked)', async () => {
    const live = docWithDefects();
    const db = await database();
    const docs: DocPorts = { isOpen: () => true, liveDoc: () => live };
    const blockedResolve = createDefectResolver({ withDoc: createWithDoc({ isBlocked: () => Promise.resolve(true), db, docs }) });
    await expect(blockedResolve('insp-1', 'p1', KEY, canned())).rejects.toMatchObject({ code: 'BLOCKED' });
    expect(defectPhotosOf(live, FK, 'canned', 'd1')).toBeUndefined();
    const openResolve = createDefectResolver({ withDoc: createWithDoc({ isBlocked: neverBlocked, db, docs }) });
    await expect(openResolve('insp-1', 'p1', KEY, canned())).resolves.toBe('resolved');
  });

  it('refuses an id or a key that could not be this photo, without reading the document', async () => {
    let calls = 0;
    const resolve = createDefectResolver({
      withDoc: <T>() => {
        calls += 1;
        return Promise.resolve('resolved' as T);
      },
    });
    await expect(resolve('../x', 'p1', KEY, canned())).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(resolve('insp-1', '../x', KEY, canned())).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(resolve('insp-1', 'p1', '../escape.jpg', canned())).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    expect(calls).toBe(0);
    await expect(resolve('insp-1', 'p1', KEY, canned())).resolves.toBe('resolved');
    expect(calls).toBe(1);
  });
});
