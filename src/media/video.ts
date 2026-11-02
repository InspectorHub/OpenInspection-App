import { isValidMediaId } from './errors';
import type { ResolveResult } from './pending-doc';
import { isStreamUploadUrl, MAX_VIDEO_BYTES, STREAM_UPLOAD_HOST, VIDEO_CONTENT_TYPES, VIDEO_MAX_SECONDS } from './media-types';
import { isValidUploadedKey, VIDEO_CHUNK_BYTES, type MediaRow, type VideoSource } from './store';
import { clampRetryAfter, failure, isParseableUrlText, isRecord, resolveRelocatableUploadUrl } from './upload-kinds';
import type { KindContext, KindStrategy, TransferTarget } from './upload-strategy';

export { MAX_VIDEO_BYTES, STREAM_UPLOAD_HOST, VIDEO_MAX_SECONDS };

/** Free space below which recording is refused: the 200 MiB clip, the platform's own working copy, and room for the rest of the work package. */
export const MIN_FREE_BYTES = 1024 * 1024 * 1024;

const VIDEO_UPLOAD_PATH = '/api/public/uploads/video';
const STREAM_KEY_PREFIX = 'stream/';
const STREAM_UID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** `<tenant>/inspections/<inspection>/videos/<media id>.<ext>`, the shape of `r2Keys.inspectionVideo` in the engine. */
const R2_KEY_PATTERN = /^([A-Za-z0-9_-]{1,64})\/inspections\/([A-Za-z0-9_-]{1,64})\/videos\/([A-Za-z0-9_-]{1,64})\.(mp4|mov)$/;
/** On Android the plugin runs the transfer in its foreground service (the `dataSync` type) and shows this title in the notification. */
const NOTIFICATION_TITLE = 'Uploading videos';

/** What the document step needs to know about a clip that is now on the server. */
export type VideoDocRef = { provider: 'r2'; mediaId: string; r2Key: string } | { provider: 'stream'; streamUid: string };

/**
 * Replaces the pending placement of a clip in the inspection's document once the server holds it. The editor package
 * (field-ui 0.2.1) has no pending-clip entry yet, so there is nothing for the app to swap by default: Task 9 supplies
 * this when the editor gains one. `missing` is handled as for a photo: the reconciler keeps the clip and asks again.
 */
export type ResolveVideo = (inspectionId: string, pendingId: string, ref: VideoDocRef) => Promise<ResolveResult>;

type KeyRow = Pick<MediaRow, 'inspectionId' | 'contentType'>;

/** The key a stored clip's upload leaves in the row, or false when `key` is anything else. Used for both backends. */
export function isExpectedVideoKey(key: unknown, row: KeyRow): key is string {
  if (!isValidUploadedKey(key)) return false;
  if (key.startsWith(STREAM_KEY_PREFIX)) return STREAM_UID_PATTERN.test(key.slice(STREAM_KEY_PREFIX.length));
  const match = R2_KEY_PATTERN.exec(key);
  if (match === null) return false;
  const ext = match[4];
  return match[2] === row.inspectionId && Object.hasOwn(VIDEO_CONTENT_TYPES, row.contentType) && ext === VIDEO_CONTENT_TYPES[row.contentType as keyof typeof VIDEO_CONTENT_TYPES];
}

/** The reference a stored key stands for, or null when the key is not this inspection's. */
export function videoRefFromKey(key: string, inspectionId: string): VideoDocRef | null {
  if (key.startsWith(STREAM_KEY_PREFIX)) {
    const streamUid = key.slice(STREAM_KEY_PREFIX.length);
    return STREAM_UID_PATTERN.test(streamUid) ? { provider: 'stream', streamUid } : null;
  }
  const match = R2_KEY_PATTERN.exec(key);
  if (match === null || match[2] !== inspectionId || match[3] === undefined) return null;
  return { provider: 'r2', mediaId: match[3], r2Key: key };
}

/**
 * Where a clip may be sent.
 *  - r2: the engine's own token route. Only its path and token are taken from the answer; the transfer url is rebuilt
 *    on the pinned origin (see `resolveRelocatableUploadUrl`), because the engine names itself by its own public origin.
 *  - stream: https on `STREAM_UPLOAD_HOST`, default port, no userinfo, no query, no fragment, and the single path
 *    segment is the uid of the answer's own ref. Anything else is refused.
 */
export function resolveVideoUploadUrl(origin: string, ref: { provider: 'r2' } | { provider: 'stream'; streamUid: string }, raw: unknown): string | null {
  if (ref.provider === 'r2') return resolveRelocatableUploadUrl(origin, raw, VIDEO_UPLOAD_PATH);
  if (!isParseableUrlText(raw) || !STREAM_UID_PATTERN.test(ref.streamUid)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!isStreamUploadUrl(url)) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  return url.pathname === `/${ref.streamUid}` ? url.href : null;
}

const REFUSED_STATUSES = [400, 403, 404, 411, 413, 415, 422];

function itemIdOf(row: MediaRow): string | null {
  try {
    const meta: unknown = JSON.parse(row.meta);
    return isRecord(meta) && typeof meta.itemId === 'string' && meta.itemId.length > 0 ? meta.itemId : null;
  } catch {
    return null;
  }
}

/** The mapping of a non-200 answer of either video route. 401 never reaches here: the context handled it. */
function statusFailure(status: number, retryAfterMs: number | null) {
  if (REFUSED_STATUSES.includes(status)) return failure('REJECTED', { retryable: false });
  if (status === 426) return failure('UPGRADE', { retryable: true, halt: true });
  return failure('SERVER', { retryable: true, retryAfterMs: clampRetryAfter(retryAfterMs) });
}

/**
 * The create-upload answer: a well-formed success that points somewhere this clip may not go is the server being
 * wrong, which waiting does not repair (permanent); anything that is not a well-formed success is transient.
 */
function parseTarget(body: unknown, row: MediaRow, origin: string): TransferTarget {
  if (!isRecord(body) || body.success !== true || !isRecord(body.data)) return { ok: false, failure: failure('BAD_URL', { retryable: true }) };
  const refused: TransferTarget = { ok: false, failure: failure('BAD_URL', { retryable: false }) };
  const { uploadURL, provider, ref } = body.data;
  if (!isRecord(ref) || ref.provider !== provider) return refused;
  if (provider === 'stream') {
    const uid = ref.streamUid;
    if (typeof uid !== 'string' || !STREAM_UID_PATTERN.test(uid)) return refused;
    const url = resolveVideoUploadUrl(origin, { provider: 'stream', streamUid: uid }, uploadURL);
    return url === null ? refused : { ok: true, url, key: `${STREAM_KEY_PREFIX}${uid}`, sendClientHeaders: false };
  }
  if (provider !== 'r2') return refused;
  const { mediaId, r2Key } = ref;
  if (typeof mediaId !== 'string' || typeof r2Key !== 'string' || !isValidMediaId(mediaId)) return refused;
  // The slot is minted with a `.mp4` placeholder; the object lands under the extension of the type the file part declares.
  const placeholder = R2_KEY_PATTERN.exec(r2Key);
  if (placeholder === null || placeholder[2] !== row.inspectionId || placeholder[3] !== mediaId || placeholder[4] !== 'mp4') return refused;
  const ext = VIDEO_CONTENT_TYPES[row.contentType as keyof typeof VIDEO_CONTENT_TYPES];
  const url = resolveVideoUploadUrl(origin, { provider: 'r2' }, uploadURL);
  if (url === null || ext === undefined) return refused;
  return { ok: true, url, key: `${placeholder[1] ?? ''}/inspections/${row.inspectionId}/videos/${mediaId}.${ext}`, sendClientHeaders: true };
}

function finalizeBody(key: string, inspectionId: string): Record<string, string> | null {
  const ref = videoRefFromKey(key, inspectionId);
  if (ref === null) return null;
  return ref.provider === 'stream' ? { provider: 'stream', streamUid: ref.streamUid } : { provider: 'r2', mediaId: ref.mediaId, r2Key: ref.r2Key };
}

/**
 * The clip strategy of the uploader: `create-upload`, then (after the file arrived) `finalize`. Both are
 * authenticated calls to the pinned origin and are bound to the row's own inspection; neither carries anything from
 * the server into an error.
 */
export function createVideoStrategy(): KindStrategy {
  return {
    kind: 'video',
    notificationTitle: NOTIFICATION_TITLE,
    maxBytes: MAX_VIDEO_BYTES,
    isExpectedKey: (key, row): key is string => isExpectedVideoKey(key, row),
    mint: async (row: MediaRow, ctx: KindContext): Promise<TransferTarget> => {
      const itemId = itemIdOf(row);
      const answer = await ctx.post(`/api/inspections/${encodeURIComponent(row.inspectionId)}/media/video/create-upload`, itemId === null ? {} : { itemId });
      if (!answer.ok) return answer;
      if (answer.res.status === 200) return parseTarget(answer.res.json, row, ctx.origin);
      return { ok: false, failure: statusFailure(answer.res.status, answer.res.retryAfterMs) };
    },
    complete: async (row, key, ctx) => {
      const body = finalizeBody(key, row.inspectionId);
      if (body === null) return { ok: false, failure: failure('BAD_URL', { retryable: false }) };
      const answer = await ctx.post(`/api/inspections/${encodeURIComponent(row.inspectionId)}/media/video/finalize`, body);
      if (!answer.ok) return answer;
      if (answer.res.status !== 200) return { ok: false, failure: statusFailure(answer.res.status, answer.res.retryAfterMs) };
      const json = answer.res.json;
      // A 200 that is not the engine's success shape (a captive portal's page) is not a finalized clip.
      const poolId = isRecord(json) && json.success === true && isRecord(json.data) ? json.data.poolId : undefined;
      if (typeof poolId !== 'string' || poolId.length === 0) return { ok: false, failure: failure('SERVER', { retryable: true }) };
      // For R2 the engine answers `readyToStream: true` once the object is at the expected key. Anything else (for
      // example a part content type that landed it under another key) is not a finalized clip yet: retry. Stream is
      // legitimately not ready right after the upload, so the flag says nothing there.
      const readyToStream = isRecord(json) && isRecord(json.data) ? json.data.readyToStream : undefined;
      if (body.provider === 'r2' && readyToStream !== true) return { ok: false, failure: failure('SERVER', { retryable: true }) };
      return { ok: true };
    },
  };
}

/** A Blob as a stream of bounded pieces. */
export function blobVideoSource(blob: Blob): VideoSource {
  return {
    contentType: blob.type,
    size: blob.size,
    chunks: async function* chunks() {
      for (let offset = 0; offset < blob.size; offset += VIDEO_CHUNK_BYTES) {
        yield new Uint8Array(await blob.slice(offset, offset + VIDEO_CHUNK_BYTES).arrayBuffer());
      }
    },
  };
}

/** The free space of the device's app storage. */
export interface DiskSpacePort {
  /** Bytes free, or null when the platform cannot say. May reject. */
  freeBytes(): Promise<number | null>;
  /**
   * True only for a port whose figure is the real free space of the storage the clips are written to (a native call).
   * Only such a port may REFUSE a recording; any other port is advisory and a low reading is the warning
   * `SPACE_UNKNOWN`.
   */
  readonly authoritative?: boolean;
}

export type SpaceCheck =
  | { ok: true; freeBytes: number }
  /** The measurement failed or made no sense: recording is allowed, because a full disk is caught when the file is written. */
  | { ok: true; freeBytes: null; warning: 'SPACE_UNKNOWN' }
  | { ok: false; code: 'LOW_SPACE'; freeBytes: number };

/**
 * Asks the port before a recording starts. Below `minBytes`, an AUTHORITATIVE port gets a refusal with the fixed code
 * `LOW_SPACE`; a port that is not authoritative gets the fixed warning `SPACE_UNKNOWN` instead, because its figure can
 * be wrong in the harmful direction (see `createStorageEstimateDiskSpace`). A port that fails or answers nothing usable is UNKNOWN, not "low": blocking every recording on a device that cannot
 * be measured would be worse than the failure it guards against, because the store removes a half-written clip and
 * reports DISK_FULL when the disk really is full. The caller shows the fixed warning.
 */
export async function checkFreeSpace(port: DiskSpacePort, minBytes: number = MIN_FREE_BYTES): Promise<SpaceCheck> {
  const threshold = Number.isFinite(minBytes) && minBytes >= 0 ? minBytes : MIN_FREE_BYTES;
  let free: number | null;
  try {
    free = await port.freeBytes();
  } catch {
    free = null;
  }
  if (free === null || !Number.isFinite(free) || free < 0) return { ok: true, freeBytes: null, warning: 'SPACE_UNKNOWN' };
  if (free >= threshold) return { ok: true, freeBytes: free };
  return port.authoritative === true ? { ok: false, code: 'LOW_SPACE', freeBytes: free } : { ok: true, freeBytes: null, warning: 'SPACE_UNKNOWN' };
}

export interface StorageEstimator {
  estimate(): Promise<{ quota?: number; usage?: number }>;
}

/**
 * A disk-space port over the web view's storage estimate (`quota - usage`). It is NOT authoritative and must never
 * gate a recording: `navigator.storage.estimate()` reports the quota of the web view's origin storage and does not
 * count the files the Capacitor Filesystem plugin writes, so the figure says nothing reliable about the space those
 * files need (it can read high or low). No installed Capacitor plugin reports free disk space (Filesystem has no such
 * call). A future native port (for example the Device plugin's `realDiskFree`, a new dependency) can declare
 * `authoritative: true` and then enables the `LOW_SPACE` refusal; this port yields only the advisory warning.
 */
export function createStorageEstimateDiskSpace(storage: StorageEstimator | undefined): DiskSpacePort {
  return {
    authoritative: false,
    freeBytes: async () => {
      if (storage === undefined) return null;
      const { quota, usage } = await storage.estimate();
      if (typeof quota !== 'number' || typeof usage !== 'number' || !Number.isFinite(quota) || !Number.isFinite(usage)) return null;
      return Math.max(0, quota - usage);
    },
  };
}

/** Thin real wiring over the web view. */
export function createRealDiskSpace(): DiskSpacePort {
  return createStorageEstimateDiskSpace(typeof navigator === 'undefined' ? undefined : navigator.storage);
}
