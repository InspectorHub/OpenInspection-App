import * as Y from 'yjs';

/**
 * `appended`: a pending entry for the photo was added. `already`: the item holds an entry with that pending id.
 * `invalid_key`: the finding key is not that of an item; the document was not touched.
 */
export type AppendResult = 'appended' | 'already' | 'invalid_key';

const MAX_FINDING_KEY_LENGTH = 512;
const CANNED_TABS = ['information', 'limitations', 'defects'] as const;

function arrays(names: readonly string[]): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  for (const name of names) map.set(name, new Y.Array<unknown>());
  return map;
}

/** The item map exactly as the editor package seeds it for an item that has no entry yet. */
function newItemMap(): Y.Map<unknown> {
  const item = new Y.Map<unknown>();
  item.set('attributes', new Y.Map<unknown>());
  item.set('tabs', arrays(CANNED_TABS));
  item.set('photos', new Y.Array<unknown>());
  item.set('recommendations', new Y.Array<unknown>());
  item.set('customComments', arrays(CANNED_TABS));
  return item;
}

/**
 * True for `unit:section:item` with three non-empty parts, the last one being `itemId`. A key that starts with an
 * underscore is an item key only with all three parts (`_default:s1:i1`); `_inspector_signature` and the like are
 * meta keys of the results blob, never items, and have fewer parts.
 */
function isItemKey(findingKey: unknown, itemId: unknown): findingKey is string {
  if (typeof findingKey !== 'string' || typeof itemId !== 'string' || itemId === '') return false;
  if (findingKey.length === 0 || findingKey.length > MAX_FINDING_KEY_LENGTH) return false;
  const parts = findingKey.split(':');
  if (parts.length !== 3 || parts.some((part) => part === '')) return false;
  return parts[parts.length - 1] === itemId;
}

/**
 * Adds the entry of a photo whose bytes are only on the device to an item, in one transaction.
 *
 * This mirrors `appendPendingPhoto(doc, findingKey, pendingId)` of the editor package: the item is seeded with its
 * full nested shape when it has no entry, and a photo with an empty `key`, `pendingUpload: true`, the `pendingId`,
 * `pendingKind: 'photo'` and `mediaType: 'photo'` is pushed unless the item already holds one with that pending id.
 * `@inspectorhub/field-ui` 0.2.1 does not export that function, so the shape is mirrored here; replace this with the
 * package export when it ships. Unlike the package function it refuses a key that is not an item key (and one whose
 * last part is not `itemId`) without writing anything. An item that already has entries is not otherwise changed.
 */
export function appendPendingInDoc(doc: Y.Doc, findingKey: string, itemId: string, pendingId: string): AppendResult {
  if (!isItemKey(findingKey, itemId) || typeof pendingId !== 'string' || pendingId === '') return 'invalid_key';
  let result: AppendResult = 'appended';
  doc.transact(() => {
    const results = doc.getMap<unknown>('results');
    let item = results.get(findingKey);
    if (!(item instanceof Y.Map)) {
      item = newItemMap();
      results.set(findingKey, item);
    }
    const entry = item as Y.Map<unknown>;
    let photos = entry.get('photos');
    if (!(photos instanceof Y.Array)) {
      photos = new Y.Array<unknown>();
      entry.set('photos', photos);
    }
    const list = photos as Y.Array<unknown>;
    if (list.toArray().some((existing) => existing instanceof Y.Map && existing.get('pendingId') === pendingId)) {
      result = 'already';
      return;
    }
    const fresh = new Y.Map<unknown>();
    fresh.set('key', '');
    fresh.set('pendingUpload', true);
    fresh.set('pendingId', pendingId);
    fresh.set('pendingKind', 'photo');
    fresh.set('mediaType', 'photo');
    list.push([fresh]);
  });
  return result;
}

/**
 * True when the item `findingKey` already holds an entry with `pendingId`. It only reads: the document is never changed,
 * and a key that is not an item key (or an item that has no entry) answers false.
 */
export function hasPendingEntryInDoc(doc: Y.Doc, findingKey: string, itemId: string, pendingId: string): boolean {
  if (!isItemKey(findingKey, itemId) || typeof pendingId !== 'string' || pendingId === '') return false;
  const item = doc.getMap<unknown>('results').get(findingKey);
  if (!(item instanceof Y.Map)) return false;
  const photos = item.get('photos');
  if (!(photos instanceof Y.Array)) return false;
  return photos.toArray().some((entry) => entry instanceof Y.Map && entry.get('pendingId') === pendingId);
}
