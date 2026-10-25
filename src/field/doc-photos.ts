import * as Y from 'yjs';

/**
 * Reads of the photo entries of the results document: an item's `photos` array holds one map per photo. The shape is
 * the one the editor writes and `media/pending-doc.ts` resolves; nothing here writes.
 */

function itemPhotos(doc: Y.Doc, findingKey?: string): Y.Array<unknown>[] {
  const results = doc.getMap<unknown>('results');
  const arrays: Y.Array<unknown>[] = [];
  const take = (item: unknown): void => {
    if (!(item instanceof Y.Map)) return;
    const photos = item.get('photos');
    if (photos instanceof Y.Array) arrays.push(photos);
  };
  if (findingKey !== undefined) take(results.get(findingKey));
  else results.forEach((item) => take(item));
  return arrays;
}

/**
 * The CURRENT position of the photo whose key is `photoKey` in the item `findingKey`, or -1 when the item or the photo
 * is gone. A crop or an annotation addresses its photo by position, and positions shift when photos are added or
 * removed, so the position is read here at the moment it is used and never taken from a queued record.
 */
export function findPhotoIndex(doc: Y.Doc, findingKey: string, photoKey: string): number {
  for (const photos of itemPhotos(doc, findingKey)) {
    for (let i = 0; i < photos.length; i += 1) {
      const entry = photos.get(i);
      if (entry instanceof Y.Map && entry.get('key') === photoKey) return i;
    }
  }
  return -1;
}

/** The `pendingId` of every photo entry in the document that still names a local record. */
export function pendingIdsInDoc(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  for (const photos of itemPhotos(doc)) {
    for (let i = 0; i < photos.length; i += 1) {
      const entry = photos.get(i);
      const id = entry instanceof Y.Map ? entry.get('pendingId') : undefined;
      if (typeof id === 'string' && id !== '') ids.add(id);
    }
  }
  return ids;
}
