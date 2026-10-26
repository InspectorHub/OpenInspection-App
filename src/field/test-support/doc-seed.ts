import * as Y from 'yjs';

/** The shape the editor writes: a results map, an item map per finding, a photos array of maps. */
export function seedPhotos(doc: Y.Doc, findingKey: string, photos: Record<string, unknown>[]): void {
  const results = doc.getMap<unknown>('results');
  doc.transact(() => {
    const item = new Y.Map<unknown>();
    const arr = new Y.Array<unknown>();
    for (const photo of photos) {
      const el = new Y.Map<unknown>();
      for (const [k, v] of Object.entries(photo)) el.set(k, v);
      arr.push([el]);
    }
    item.set('photos', arr);
    results.set(findingKey, item);
  });
}

/** The photo entries of one item as plain objects. */
export function photosOf(doc: Y.Doc, findingKey: string): Record<string, unknown>[] {
  const item = doc.getMap<unknown>('results').get(findingKey);
  if (!(item instanceof Y.Map)) return [];
  const arr = item.get('photos');
  return arr instanceof Y.Array ? arr.toArray().map((el) => (el as Y.Map<unknown>).toJSON() as Record<string, unknown>) : [];
}

/** Removes the photo entries matching `test` from one item, as the editor does when a photo is deleted. */
export function removePhotos(doc: Y.Doc, findingKey: string, test: (entry: Record<string, unknown>) => boolean): void {
  const item = doc.getMap<unknown>('results').get(findingKey);
  if (!(item instanceof Y.Map)) return;
  const arr = item.get('photos');
  if (!(arr instanceof Y.Array)) return;
  doc.transact(() => {
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      const el = arr.get(i);
      if (el instanceof Y.Map && test(el.toJSON() as Record<string, unknown>)) arr.delete(i, 1);
    }
  });
}

interface SeededDefect {
  /** `cannedId` for a canned defect, `id` for a custom one. */
  id: string;
  photos?: unknown[];
}

/**
 * An item the way the editor shapes it once it has defect rows: `tabs.defects` (by `cannedId`) and `customComments.defects`
 * (by `id`) are Y arrays of maps, and a defect's `photos` is a plain list stored as one value.
 */
export function seedDefects(doc: Y.Doc, findingKey: string, defects: { canned?: SeededDefect[]; custom?: SeededDefect[] }): void {
  const results = doc.getMap<unknown>('results');
  const group = (entries: SeededDefect[], identity: string): Y.Map<unknown> => {
    const map = new Y.Map<unknown>();
    const list = new Y.Array<unknown>();
    for (const entry of entries) {
      const el = new Y.Map<unknown>();
      el.set(identity, entry.id);
      el.set('included', true);
      if (entry.photos !== undefined) el.set('photos', entry.photos);
      list.push([el]);
    }
    map.set('defects', list);
    return map;
  };
  doc.transact(() => {
    const existing = results.get(findingKey);
    const item: Y.Map<unknown> = existing instanceof Y.Map ? (existing as Y.Map<unknown>) : new Y.Map<unknown>();
    if (!(existing instanceof Y.Map)) results.set(findingKey, item);
    item.set('tabs', group(defects.canned ?? [], 'cannedId'));
    item.set('customComments', group(defects.custom ?? [], 'id'));
    if (!(item.get('photos') instanceof Y.Array)) item.set('photos', new Y.Array<unknown>());
  });
}

/** The `photos` list of one defect row as plain data; undefined when the defect or its list is not there. */
export function defectPhotosOf(doc: Y.Doc, findingKey: string, kind: 'canned' | 'custom', id: string): unknown[] | undefined {
  const item = doc.getMap<unknown>('results').get(findingKey);
  if (!(item instanceof Y.Map)) return undefined;
  const group = item.get(kind === 'canned' ? 'tabs' : 'customComments');
  const list = group instanceof Y.Map ? group.get('defects') : undefined;
  if (!(list instanceof Y.Array)) return undefined;
  const defect = list.toArray().find((el) => el instanceof Y.Map && el.get(kind === 'canned' ? 'cannedId' : 'id') === id);
  return defect instanceof Y.Map ? (defect.get('photos') as unknown[] | undefined) : undefined;
}
