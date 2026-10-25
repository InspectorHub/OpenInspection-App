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
