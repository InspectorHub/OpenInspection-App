import type { PhotoSize } from '@inspectorhub/field-ui';
import { isValidUploadedKey, type MediaRow, type MediaStore } from '../media/store';
import type { Files } from '../platform/files';
import type { LocalCopyReader, LocalPhotoCopy, PhotoCache } from './photo-cache';

/**
 * `FieldUrls.photo(inspectionId, key)` is SYNCHRONOUS, and the server's photo route needs the Bearer header, which an
 * `<img src>` cannot send. So a photo that is only on the server has no address the web view can show. What the
 * editor can show is a photo whose bytes are on this device, through an index from the photo's key to a local address.
 *
 * This file is the index and the function over it. It does not download anything itself: a photo that is only on the
 * server is asked of the photo cache (`photo-cache.ts`), which fetches it with the session and answers the same kind of
 * local address once it is on the device. Until then, and when it cannot be fetched, the answer is the placeholder. The
 * placeholder is a fixed image with no address in it, so a missing photo shows as missing and never as a request that
 * would fail or leak.
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
    case 'oi-media:':
      // The desktop shell's own scheme for files in its media folder (Electron only; no other host produces it).
      return url.hostname === 'media';
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
  /** Copies of server photos. Absent: only photos whose file is on the device can be shown. */
  cache?: Pick<PhotoCache, 'lookup'>;
}

/** `<tenant>/inspections/<inspection>/` followed by a key made only of plain segments. */
function belongs(tenantId: string, inspectionId: string, key: string): boolean {
  return isValidUploadedKey(key) && key.startsWith(`${tenantId}/inspections/${inspectionId}/`);
}

/**
 * `size` is the editor's optional hint (`thumb` | `view` | `original`). A photo whose file is on the device is one copy
 * and answers every size alike. A photo that is only on the server is asked of the cache in the size the caller needs
 * (no hint: the original, as the web host does). The key is checked first, so a key that is not under this account's
 * inspection never reaches the cache and so never becomes a request.
 */
export function createPhotoUrls(deps: PhotoUrlsDeps): (inspectionId: string, key: string, size?: PhotoSize) => string {
  return (inspectionId, key, size) => {
    if (!belongs(deps.tenantId, inspectionId, key)) return PHOTO_PLACEHOLDER_URL;
    return deps.index.lookup(inspectionId, key) ?? deps.cache?.lookup(inspectionId, key, size ?? 'original') ?? PHOTO_PLACEHOLDER_URL;
  };
}

/**
 * The bytes of an uploaded photo whose file is still on this device, for the photo cache to adopt: the answer to "show
 * the photo I just uploaded" without a request, and without depending on the file still being here later.
 */
export function createUploadedCopyReader(store: Pick<MediaStore, 'listRows'>, files: Pick<Files, 'read'>): LocalCopyReader {
  const readRow = async (row: MediaRow): Promise<LocalPhotoCopy | null> => {
    try {
      return { bytes: await files.read(row.path), contentType: row.contentType };
    } catch {
      return null;
    }
  };
  const uploadedRows = async (inspectionId: string): Promise<MediaRow[]> => {
    try {
      return (await store.listRows({ inspectionId, states: ['uploaded'], kinds: ['photo'] })).filter((row) => row.state === 'uploaded' && row.uploadedKey !== null);
    } catch {
      return [];
    }
  };
  return Object.assign(
    async (inspectionId: string, key: string) => {
      const row = (await uploadedRows(inspectionId)).find((candidate) => candidate.uploadedKey === key);
      return row === undefined ? null : readRow(row);
    },
    {
      // The rows are read once; each key then costs only its own file.
      open: async (inspectionId: string) => {
        const byKey = new Map((await uploadedRows(inspectionId)).map((row) => [row.uploadedKey, row] as const));
        return async (key: string) => {
          const row = byKey.get(key);
          return row === undefined ? null : readRow(row);
        };
      },
    },
  );
}

/**
 * Indexes the photos that are already on the server but whose file is still on this device (uploaded, not yet cleaned
 * up): their key maps to the local file. Answers how many were indexed; a store that cannot be read indexes none.
 */
export async function indexUploadedRows(index: PhotoIndex, store: Pick<MediaStore, 'listRows' | 'objectUrl'>, inspectionId: string, only?: ReadonlySet<string>): Promise<number> {
  try {
    const rows = await store.listRows({ inspectionId, states: ['uploaded'], kinds: ['photo'] });
    const entries: [string, string][] = [];
    for (const row of rows) {
      // Only a photo the server holds, whose file is still here: a pending row has no server key to show it under.
      if (row.state !== 'uploaded' || row.uploadedKey === null || (only !== undefined && !only.has(row.uploadedKey))) continue;
      const url = await store.objectUrl(row.pendingId);
      if (url !== null) entries.push([row.uploadedKey, url]);
    }
    index.add(inspectionId, entries);
    return entries.length;
  } catch {
    return 0;
  }
}
