import { isValidUploadedKey, type MediaStore } from '../media/store';

/**
 * `FieldUrls.photo(inspectionId, key)` is SYNCHRONOUS, and the server's photo route needs the Bearer header, which an
 * `<img src>` cannot send. So a photo that is only on the server has no address the web view can show. What the
 * editor can show is a photo whose bytes are on this device, through an index from the photo's key to a local address.
 *
 * This file is the index and the function over it. It does not download anything: thumbnails for photos that were
 * uploaded before the work package was taken need a download step that does not exist yet, and until it does the answer
 * for those is the placeholder. The placeholder is a fixed image with no address in it, so a missing photo shows as
 * missing and never as a request that would fail or leak.
 *
 * Nothing that reaches the editor carries a credential: the index refuses an address with a credential in it or one
 * that does not point at this device, and the function refuses a key that is not under this account's inspection.
 */

/** A neutral grey tile. A data address with nothing in it but the shape. */
export const PHOTO_PLACEHOLDER_URL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#e5e7eb"/><path d="M50 84l22-28 16 20 10-12 20 20z" fill="#9ca3af"/><circle cx="58" cy="42" r="8" fill="#9ca3af"/></svg>',
)}`;

export function isPhotoPlaceholder(url: string): boolean {
  return url === PHOTO_PLACEHOLDER_URL;
}

export interface PhotoIndex {
  /** The local address of a cached photo, or null. */
  lookup(inspectionId: string, key: string): string | null;
  /** Replaces what is cached for the inspection. Addresses that are not local or carry a credential are dropped. */
  set(inspectionId: string, entries: Iterable<readonly [key: string, url: string]>): void;
  /** Adds to what is cached for the inspection, under the same rules. */
  add(inspectionId: string, entries: Iterable<readonly [key: string, url: string]>): void;
  /** Forgets one inspection, or all of them. */
  clear(inspectionId?: string): void;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const CREDENTIAL_PARAM = /token|auth|secret|signature|jwt|credential|password|key/i;

/** True for an address that points at this device and carries no credential. */
function isLocalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username !== '' || url.password !== '') return false;
  for (const name of url.searchParams.keys()) if (CREDENTIAL_PARAM.test(name)) return false;
  switch (url.protocol) {
    case 'capacitor:':
    case 'file:':
    case 'blob:':
      return true;
    case 'http:':
    case 'https:':
      return LOCAL_HOSTS.has(url.hostname);
    default:
      return false;
  }
}

export function createMemoryPhotoIndex(): PhotoIndex {
  const byInspection = new Map<string, Map<string, string>>();
  const add = (inspectionId: string, entries: Iterable<readonly [string, string]>): void => {
    const target = byInspection.get(inspectionId) ?? new Map<string, string>();
    for (const [key, url] of entries) if (isLocalUrl(url)) target.set(key, url);
    byInspection.set(inspectionId, target);
  };
  return {
    lookup: (inspectionId, key) => byInspection.get(inspectionId)?.get(key) ?? null,
    add,
    set: (inspectionId, entries) => {
      byInspection.delete(inspectionId);
      add(inspectionId, entries);
    },
    clear: (inspectionId) => {
      if (inspectionId === undefined) byInspection.clear();
      else byInspection.delete(inspectionId);
    },
  };
}

export interface PhotoUrlsDeps {
  /** The signed-in account's company: a key is only ever served for its own. */
  tenantId: string;
  index: PhotoIndex;
}

/** `<tenant>/inspections/<inspection>/` followed by a key made only of plain segments. */
function belongs(tenantId: string, inspectionId: string, key: string): boolean {
  return isValidUploadedKey(key) && key.startsWith(`${tenantId}/inspections/${inspectionId}/`);
}

export function createPhotoUrls(deps: PhotoUrlsDeps): (inspectionId: string, key: string) => string {
  return (inspectionId, key) => {
    if (!belongs(deps.tenantId, inspectionId, key)) return PHOTO_PLACEHOLDER_URL;
    return deps.index.lookup(inspectionId, key) ?? PHOTO_PLACEHOLDER_URL;
  };
}

/**
 * Indexes the photos that are already on the server but whose file is still on this device (uploaded, not yet cleaned
 * up): their key maps to the local file. Answers how many were indexed; a store that cannot be read indexes none.
 */
export async function indexUploadedRows(index: PhotoIndex, store: Pick<MediaStore, 'listRows' | 'objectUrl'>, inspectionId: string): Promise<number> {
  try {
    const rows = await store.listRows({ inspectionId, states: ['uploaded'], kinds: ['photo'] });
    const entries: [string, string][] = [];
    for (const row of rows) {
      // Only a photo the server holds, whose file is still here: a pending row has no server key to show it under.
      if (row.state !== 'uploaded' || row.uploadedKey === null) continue;
      const url = await store.objectUrl(row.pendingId);
      if (url !== null) entries.push([row.uploadedKey, url]);
    }
    index.add(inspectionId, entries);
    return entries.length;
  } catch {
    return 0;
  }
}
