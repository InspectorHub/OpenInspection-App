import { describe, expect, it } from 'vitest';
import { defectTargetOf, defectTargetOfMeta } from './defect-target';
import { createMediaWorld, defectPhotoRecord, INSPECTION, photoRecord } from './test-support/fakes';

describe('the device store takes a photo of a defect row', () => {
  it('stores the bytes and the row (kind photo, pending) with the defect named in the meta', async () => {
    const world = await createMediaWorld();
    await world.store.put(defectPhotoRecord('d-1', { customId: 'c9', defectKind: 'canned' }));
    expect(world.files.paths()).toEqual(['media/d-1.jpg']);
    const row = await world.store.getRow('d-1');
    expect(row).toMatchObject({ pendingId: 'd-1', inspectionId: INSPECTION, kind: 'photo', state: 'pending', attempts: 0 });
    expect(row === null ? null : defectTargetOf(row)).toEqual({ findingKey: '_default:s1:i1', itemId: 'i1', customId: 'c9', defectKind: 'canned' });
  });

  it.each<[string, Record<string, unknown>]>([
    ['no defect id', { targetType: 'defect', findingKey: 'k', itemId: 'i', defectKind: 'custom' }],
    ['an empty defect id', { targetType: 'defect', findingKey: 'k', itemId: 'i', customId: '', defectKind: 'custom' }],
    ['an unknown defect kind', { targetType: 'defect', findingKey: 'k', itemId: 'i', customId: 'c', defectKind: 'other' }],
    ['no item id', { targetType: 'defect', findingKey: 'k', customId: 'c', defectKind: 'custom' }],
  ])('still refuses a defect meta with %s (control: the well-formed one is stored)', async (_name, meta) => {
    const world = await createMediaWorld();
    const bad = { ...photoRecord('d-1'), meta } as unknown as Parameters<typeof world.store.put>[0];
    await expect(world.store.put(bad)).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    expect(world.files.writeCalls()).toEqual([]);
    await world.store.put(defectPhotoRecord('d-2'));
    expect(world.files.paths()).toEqual(['media/d-2.jpg']);
  });
});

describe('a defect photo row is invisible to the editor and visible to the app', () => {
  it('list and get never return it; listRows and getRow do (control: an item photo row is returned by all four)', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('item-1', { createdAt: 1 }));
    await world.store.put(defectPhotoRecord('defect-1', { createdAt: 2 }));

    expect((await world.store.list(INSPECTION)).map((r) => r.pendingId)).toEqual(['item-1']);
    expect((await world.store.list()).map((r) => r.pendingId)).toEqual(['item-1']);
    expect(await world.store.get('defect-1')).toBeNull();
    expect((await world.store.get('item-1'))?.pendingId).toBe('item-1');

    expect((await world.store.listRows({ inspectionId: INSPECTION })).map((r) => r.pendingId)).toEqual(['item-1', 'defect-1']);
    expect((await world.store.getRow('defect-1'))?.pendingId).toBe('defect-1');
    expect((await world.store.listRowsPage({ kinds: ['photo'] })).rows.map((r) => r.pendingId)).toEqual(['item-1', 'defect-1']);
  });

  it('the bytes stay reachable for the app: the file is on disk and the object url is served', async () => {
    const world = await createMediaWorld();
    await world.store.put(defectPhotoRecord('defect-1'));
    expect(await world.store.objectUrl('defect-1')).not.toBeNull();
    const row = await world.store.getRow('defect-1');
    expect(row === null ? false : await world.store.fileExists(row)).toBe(true);
  });
});

describe('defectTargetOf', () => {
  it('names the defect of a defect photo row only', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('item-1'));
    await world.store.put(defectPhotoRecord('defect-1'));
    const item = await world.store.getRow('item-1');
    const defect = await world.store.getRow('defect-1');
    if (item === null || defect === null) throw new Error('rows missing');
    expect(defectTargetOf(item)).toBeNull();
    expect(defectTargetOf(defect)).toMatchObject({ customId: 'd1', defectKind: 'custom' });
    expect(defectTargetOf({ kind: 'video', meta: JSON.stringify(JSON.parse(defect.meta)) })).toBeNull();
    expect(defectTargetOf({ kind: 'photo', meta: '{not json' })).toBeNull();
  });

  it('reads a meta that is not an object, or whose targetType is not defect, as no defect', () => {
    expect(defectTargetOfMeta(null)).toBeNull();
    expect(defectTargetOfMeta([])).toBeNull();
    expect(defectTargetOfMeta('defect')).toBeNull();
    expect(defectTargetOfMeta({ targetType: 'item', findingKey: 'k', itemId: 'i', customId: 'c', defectKind: 'custom' })).toBeNull();
    for (const broken of [{ customId: '' }, { customId: 7 }, { itemId: '' }, { findingKey: '' }, { defectKind: 'other' }]) {
      expect(defectTargetOfMeta({ targetType: 'defect', findingKey: 'k', itemId: 'i', customId: 'c', defectKind: 'custom', ...broken }), JSON.stringify(broken)).toBeNull();
    }
    expect(defectTargetOfMeta({ targetType: 'defect', findingKey: 'k', itemId: 'i', customId: 'c', defectKind: 'custom' })).toEqual({ findingKey: 'k', itemId: 'i', customId: 'c', defectKind: 'custom' });
  });
});
