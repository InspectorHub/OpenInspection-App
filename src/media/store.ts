import type {
  PendingMediaRecord,
  PendingMediaStore,
  PhotoAnnotateMeta,
  PhotoCropMeta,
  PhotoUploadMeta,
} from '@inspectorhub/field-ui';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import { assertMediaState, type MediaState } from '../platform/schema';
import { isValidMediaId, MediaError } from './errors';

/**
 * Content types the store accepts and the file extension each is stored under. The extension comes from
 * these tables only, never from a file name. Photos are exactly the set the engine's signed photo upload accepts
 * (`image/jpeg`, `image/png`, `image/heic`); clips are the two of the engine's video upload types the app records
 * (`video/mp4`, and `video/quicktime`, which the engine stores as `.mov`). A type the server would refuse is not
 * stored, so nothing can sit on the device waiting for an upload that can never succeed.
 */
export const PHOTO_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
} as const;

export const VIDEO_CONTENT_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
} as const;

export const MEDIA_CONTENT_TYPES = { ...PHOTO_CONTENT_TYPES, ...VIDEO_CONTENT_TYPES } as const;

export type MediaContentType = keyof typeof MEDIA_CONTENT_TYPES;
export type VideoContentType = keyof typeof VIDEO_CONTENT_TYPES;

/** The engine's photo ceiling (10 MiB), checked here so an oversized photo is refused before it is written. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/** The engine's clip ceiling (`MAX_VIDEO_BYTES` of its video upload route, 200 MiB). A constant: nothing the user or a server sends changes it. */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/** The longest single clip, the same 30 seconds the engine asks Stream to enforce and the web capture sheet shows. */
export const VIDEO_MAX_SECONDS = 30;
/** Bytes per piece when a Blob is streamed to disk. */
export const VIDEO_CHUNK_BYTES = 1024 * 1024;

/** Largest serialised `meta` accepted; an annotation node tree is the biggest legitimate one. */
const MAX_META_CHARS = 1_000_000;
const MAX_KEY_CHARS = 512;
const KEY_PATTERN = /^[A-Za-z0-9_\-/.]{1,512}$/;
/** Rows one query returns when the caller names no limit. */
export const DEFAULT_LIST_LIMIT = 1000;

/** The kinds of the editor's pending records, plus the clip, which the editor's store contract does not know. */
export type MediaKind = PendingMediaRecord['kind'] | 'video';
const MEDIA_KINDS: readonly MediaKind[] = ['photo', 'crop', 'annotate', 'video'];

export function isContentType(value: string): value is MediaContentType {
  return Object.hasOwn(MEDIA_CONTENT_TYPES, value);
}

export function isVideoContentType(value: string): value is VideoContentType {
  return Object.hasOwn(VIDEO_CONTENT_TYPES, value);
}

function isPhotoContentType(value: string): value is keyof typeof PHOTO_CONTENT_TYPES {
  return Object.hasOwn(PHOTO_CONTENT_TYPES, value);
}

/** What the app keeps about a clip besides its bytes: where it was meant to go, and how long it is. */
export interface VideoMeta {
  itemId?: string;
  durationSec?: number;
}

/** A clip as a stream of pieces, so that 200 MiB is never held in memory at once. */
export interface VideoSource {
  contentType: string;
  /** The exact number of bytes `chunks()` yields. Checked on the way in, not trusted. */
  size: number;
  chunks(): AsyncIterable<Uint8Array>;
}

export interface VideoRecord {
  pendingId: string;
  inspectionId: string;
  createdAt: number;
  meta: VideoMeta;
  source: VideoSource;
}

/** `media/<pendingId>.<ext>`, relative to the no-backup library directory. */
export function mediaPath(pendingId: string, contentType: MediaContentType): string {
  return `media/${pendingId}.${MEDIA_CONTENT_TYPES[contentType]}`;
}

/** One `media` table row, validated: every field is of the shape this store writes. */
export interface MediaRow {
  pendingId: string;
  inspectionId: string;
  kind: MediaKind;
  path: string;
  contentType: MediaContentType;
  /** The record's `meta`, as JSON. */
  meta: string;
  state: MediaState;
  attempts: number;
  uploadedKey: string | null;
  createdAt: number;
}

export interface RowFilter {
  inspectionId?: string;
  states?: readonly MediaState[];
  kinds?: readonly MediaKind[];
  /** Leaves out rows that are `failed` with at least this many attempts (given up on). */
  skipGivenUpAt?: number;
  /** Keyset cursor: only rows after this one in `created_at, pending_id` order. */
  after?: { createdAt: number; pendingId: string };
  limit?: number;
}

export interface MarkPatch {
  attempts?: number;
  uploadedKey?: string | null;
  /** Makes the update conditional: it applies only to a row that is in this state right now (one UPDATE, no read first). */
  ifState?: MediaState;
}

/** One page of the table: the valid rows, how many rows the query returned, and where the next page starts. */
export interface RowPage {
  rows: MediaRow[];
  /** Rows the query returned, valid or not. A page is the last one only when this is below the limit. */
  rawCount: number;
  /** The cursor after the last row the query returned (valid or not), or null when there is none to continue from. */
  next: { createdAt: number; pendingId: string } | null;
}

/**
 * The field-ui `PendingMediaStore` over the app's SQLite table and the no-backup library directory.
 *
 * Differences from the web store that callers must know:
 *  - `put` for an id that already has a row is silently ignored and keeps the FIRST file and row (the web
 *    store overwrites the stored blob). A retried save therefore never touches a file that may be uploading.
 *    A different inspection or kind under the same id is refused with CONFLICT.
 *  - Removing a photo from the editor does not remove its row: whoever removes the photo from a document must
 *    also call `delete(pendingId)`, or the uploaded file stays on the device (the reconciler only counts such
 *    rows, see `countUnreferenced`).
 *
 * `get` and `list` return records whose `blob` is an EMPTY blob of the right type: the bytes stay on disk
 * and are shown through `objectUrl` and sent by the native uploader from the file itself, so a list of 50
 * photos never holds 50 photos in memory. Nothing in the editor reads `blob` after `put`.
 */
export interface MediaStore extends PendingMediaStore {
  /** The validated row, or null when there is none or the stored row is not one this store would have written. */
  getRow(pendingId: string): Promise<MediaRow | null>;
  /**
   * Stores a recorded clip: the file first (streamed, never whole in memory), then the row, with the same rules as
   * `put` (a repeated id keeps the first file, a different inspection or kind conflicts). The editor's contract has
   * no clip record, so `get` and `list` never return one; `getRow` and `listRows` do.
   */
  putVideo(rec: VideoRecord): Promise<void>;
  /** The size of the row's file in bytes, null when the platform did not report one. Rejects when it cannot be read. */
  fileSize(row: MediaRow): Promise<number | null>;
  /** Valid rows, oldest first. Rows that fail validation are left out, never thrown on. */
  listRows(filter?: RowFilter): Promise<MediaRow[]>;
  /**
   * Like `listRows`, but also reports the raw row count and the cursor of the last raw row, so a caller pages on
   * what the query returned: a corrupt row in a page cannot end the paging early and starve the rows behind it.
   */
  listRowsPage(filter?: RowFilter): Promise<RowPage>;
  /** Returns whether a row matched. `state` is checked with `assertMediaState`. */
  markState(pendingId: string, state: MediaState, patch?: MarkPatch): Promise<boolean>;
  /** The `file://` uri of the row's file. */
  fileUri(row: MediaRow): Promise<string>;
  fileExists(row: MediaRow): Promise<boolean>;
}

export interface MediaStoreDeps {
  db: Db;
  files: Files;
  /** Called after a NEW row was stored (not for a repeated put), so the uploader can be started. A throw is ignored. */
  onStored?: (pendingId: string) => void;
}

const COLUMNS = 'pending_id, inspection_id, kind, path, content_type, meta, state, attempts, uploaded_key, created_at';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isValidUploadedKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_KEY_CHARS && KEY_PATTERN.test(value) && !value.split('/').some((part) => part === '' || part === '.' || part === '..');
}

function isPhotoMeta(value: unknown): value is PhotoUploadMeta {
  if (!isRecord(value) || !isText(value.findingKey) || !isText(value.itemId)) return false;
  if (value.targetType === 'item') return true;
  return value.targetType === 'defect' && isText(value.customId) && (value.defectKind === 'canned' || value.defectKind === 'custom');
}

function isDerivativeBase(value: Record<string, unknown>): boolean {
  return (
    isText(value.findingKey) &&
    isText(value.itemId) &&
    typeof value.photoIndex === 'number' &&
    Number.isFinite(value.photoIndex) &&
    typeof value.photoKey === 'string' &&
    (value.sectionId === undefined || typeof value.sectionId === 'string')
  );
}

function isCropMeta(value: unknown): value is PhotoCropMeta {
  return isRecord(value) && isDerivativeBase(value) && isRecord(value.crop);
}

function isAnnotateMeta(value: unknown): value is PhotoAnnotateMeta {
  return isRecord(value) && isDerivativeBase(value) && typeof value.nodesJson === 'string';
}

/** The meta of `rec` as JSON, or throws INVALID_RECORD. A defect photo is refused, as the web store refuses it. */
function serializeMeta(rec: PendingMediaRecord): string {
  const valid =
    rec.kind === 'photo' ? isPhotoMeta(rec.meta) && rec.meta.targetType === 'item' : rec.kind === 'crop' ? isCropMeta(rec.meta) : isAnnotateMeta(rec.meta);
  if (!valid) throw new MediaError('INVALID_RECORD');
  const json = JSON.stringify(rec.meta);
  if (json.length > MAX_META_CHARS) throw new MediaError('INVALID_RECORD');
  return json;
}

function isVideoMeta(value: unknown): value is VideoMeta {
  if (!isRecord(value)) return false;
  if (value.itemId !== undefined && !isText(value.itemId)) return false;
  const { durationSec } = value;
  return durationSec === undefined || (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec >= 0 && durationSec <= VIDEO_MAX_SECONDS);
}

function videoMetaValid(meta: string): boolean {
  try {
    return isVideoMeta(JSON.parse(meta));
  } catch {
    return false;
  }
}

/** True for the messages a full disk produces on Android, iOS and the web view. */
function looksLikeFullDisk(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /no space left|ENOSPC|disk full|not enough (?:free )?space|insufficient storage|quota/i.test(message);
}

function rowFromDb(raw: Record<string, unknown>): MediaRow | null {
  const { pending_id: pendingId, inspection_id: inspectionId, kind, path, content_type: contentType, meta, state, uploaded_key: uploadedKey } = raw;
  if (!isValidMediaId(pendingId) || !isValidMediaId(inspectionId)) return null;
  if (typeof kind !== 'string' || !(MEDIA_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof contentType !== 'string' || !isContentType(contentType)) return null;
  // A clip carries a clip type and a photo an image type; a row that mixes them was not written by this store.
  if ((kind === 'video') !== isVideoContentType(contentType)) return null;
  // The path is a function of the id and the type; a row that says anything else was not written by this store.
  const expectedPath = mediaPath(pendingId, contentType);
  if (path !== expectedPath) return null;
  if (typeof meta !== 'string' || meta.length > MAX_META_CHARS) return null;
  if (kind === 'video' && !videoMetaValid(meta)) return null;
  try {
    assertMediaState(state);
  } catch {
    return null;
  }
  const attempts = Number(raw.attempts);
  const createdAt = Number(raw.created_at);
  if (!Number.isInteger(attempts) || attempts < 0 || !Number.isFinite(createdAt)) return null;
  if (uploadedKey !== null && uploadedKey !== undefined && !isValidUploadedKey(uploadedKey)) return null;
  return {
    pendingId,
    inspectionId,
    kind: kind as MediaKind,
    path: expectedPath,
    contentType,
    meta,
    state,
    attempts,
    uploadedKey: typeof uploadedKey === 'string' ? uploadedKey : null,
    createdAt,
  };
}

function recordFromRow(row: MediaRow): PendingMediaRecord | null {
  let meta: unknown;
  try {
    meta = JSON.parse(row.meta);
  } catch {
    return null;
  }
  const base = { pendingId: row.pendingId, inspectionId: row.inspectionId, blob: new Blob([], { type: row.contentType }), createdAt: row.createdAt };
  // The editor's store contract has no clip record: a clip is reached through `getRow` and the uploader only.
  if (row.kind === 'video') return null;
  if (row.kind === 'photo') return isPhotoMeta(meta) ? { ...base, kind: 'photo', meta } : null;
  if (row.kind === 'crop') return isCropMeta(meta) ? { ...base, kind: 'crop', meta } : null;
  return isAnnotateMeta(meta) ? { ...base, kind: 'annotate', meta } : null;
}

function contentTypeOf(blob: Blob): MediaContentType {
  const declared = (blob.type.split(';')[0] ?? '').trim().toLowerCase();
  if (!isPhotoContentType(declared)) throw new MediaError('UNSUPPORTED_TYPE');
  return declared;
}

/** The meta of a clip as JSON, or throws INVALID_RECORD / TOO_LONG. */
function serializeVideoMeta(meta: VideoMeta): string {
  if (typeof meta !== 'object' || meta === null) throw new MediaError('INVALID_RECORD');
  const { durationSec } = meta;
  if (durationSec !== undefined) {
    if (typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec < 0) throw new MediaError('INVALID_RECORD');
    if (durationSec > VIDEO_MAX_SECONDS) throw new MediaError('TOO_LONG');
  }
  if (meta.itemId !== undefined && !isText(meta.itemId)) throw new MediaError('INVALID_RECORD');
  return JSON.stringify({
    ...(meta.itemId === undefined ? {} : { itemId: meta.itemId }),
    ...(durationSec === undefined ? {} : { durationSec }),
  });
}

/** Marks a failure of the clip's own source, so it is not mistaken for a failure of the disk. */
class SourceFailure extends Error {}

export function createMediaStore(deps: MediaStoreDeps): MediaStore {
  const { db, files } = deps;
  /** A put for an id waits for the one before it, so two puts of one id never write the file at the same time. */
  const putChain = new Map<string, Promise<void>>();

  async function rawRow(pendingId: string): Promise<Record<string, unknown> | null> {
    const rows = await db.query<Record<string, unknown>>(`SELECT ${COLUMNS} FROM media WHERE pending_id = ?`, [pendingId]);
    return rows[0] ?? null;
  }

  async function putLocked(rec: PendingMediaRecord): Promise<void> {
    const metaJson = serializeMeta(rec);
    if (!Number.isFinite(rec.createdAt)) throw new MediaError('INVALID_RECORD');
    const contentType = contentTypeOf(rec.blob);
    if (rec.blob.size === 0) throw new MediaError('EMPTY');
    if (rec.blob.size > MAX_MEDIA_BYTES) throw new MediaError('TOO_LARGE');

    const existing = await rawRow(rec.pendingId);
    if (existing) {
      // A repeated put (a retried save) must not touch a file that may already be uploading.
      if (existing.inspection_id === rec.inspectionId && existing.kind === rec.kind) return;
      throw new MediaError('CONFLICT');
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await rec.blob.arrayBuffer());
    } catch {
      throw new MediaError('READ_FAILED');
    }
    if (bytes.length === 0) throw new MediaError('EMPTY');
    if (bytes.length > MAX_MEDIA_BYTES) throw new MediaError('TOO_LARGE');

    const path = mediaPath(rec.pendingId, contentType);
    try {
      await files.write(path, bytes);
    } catch {
      throw new MediaError('WRITE_FAILED');
    }
    try {
      await db.run(
        `INSERT OR IGNORE INTO media (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [rec.pendingId, rec.inspectionId, rec.kind, path, contentType, metaJson, 'pending', 0, null, Math.floor(rec.createdAt)],
      );
    } catch {
      // The row is the only thing that would ever find this file; without it the file is an orphan.
      await files.remove(path).catch(() => undefined);
      throw new MediaError('DB_FAILED');
    }
    try {
      deps.onStored?.(rec.pendingId);
    } catch {
      // A failing listener must not undo a photo that is safely stored.
    }
  }

  async function putVideoLocked(rec: VideoRecord): Promise<void> {
    const metaJson = serializeVideoMeta(rec.meta);
    if (!Number.isFinite(rec.createdAt)) throw new MediaError('INVALID_RECORD');
    const declaredType = (rec.source.contentType.split(';')[0] ?? '').trim().toLowerCase();
    if (!isVideoContentType(declaredType)) throw new MediaError('UNSUPPORTED_TYPE');
    const declared = rec.source.size;
    if (!Number.isInteger(declared) || declared < 0) throw new MediaError('INVALID_RECORD');
    if (declared === 0) throw new MediaError('EMPTY');
    if (declared > MAX_VIDEO_BYTES) throw new MediaError('TOO_LARGE');

    const existing = await rawRow(rec.pendingId);
    if (existing) {
      if (existing.inspection_id === rec.inspectionId && existing.kind === 'video') return;
      throw new MediaError('CONFLICT');
    }

    const path = mediaPath(rec.pendingId, declaredType);
    let written = 0;
    // The declared size is a claim: the stream is cut off the moment it delivers more than it said.
    async function* counted(): AsyncGenerator<Uint8Array> {
      try {
        for await (const chunk of rec.source.chunks()) {
          written += chunk.length;
          if (written > declared) throw new MediaError('TOO_LARGE');
          yield chunk;
        }
      } catch (error) {
        throw error instanceof MediaError ? error : new SourceFailure();
      }
    }
    try {
      await files.writeStream(path, counted());
    } catch (error) {
      if (error instanceof MediaError) throw error;
      if (error instanceof SourceFailure) throw new MediaError('READ_FAILED');
      throw new MediaError(looksLikeFullDisk(error) ? 'DISK_FULL' : 'WRITE_FAILED');
    }
    if (written !== declared) {
      await files.remove(path).catch(() => undefined);
      throw new MediaError('READ_FAILED');
    }
    try {
      await db.run(
        `INSERT OR IGNORE INTO media (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [rec.pendingId, rec.inspectionId, 'video', path, declaredType, metaJson, 'pending', 0, null, Math.floor(rec.createdAt)],
      );
    } catch {
      await files.remove(path).catch(() => undefined);
      throw new MediaError('DB_FAILED');
    }
    try {
      deps.onStored?.(rec.pendingId);
    } catch {
      // A failing listener must not undo a clip that is safely stored.
    }
  }

  /** A put for an id waits for the one before it, so two puts of one id never write the file at the same time. */
  function serialised(id: string, work: () => Promise<void>): Promise<void> {
    const run = (putChain.get(id) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    putChain.set(id, settled);
    void settled.then(() => {
      if (putChain.get(id) === settled) putChain.delete(id);
    });
    return run;
  }

  function put(rec: PendingMediaRecord): Promise<void> {
    if (!isValidMediaId(rec.pendingId) || !isValidMediaId(rec.inspectionId)) return Promise.reject(new MediaError('INVALID_ID'));
    return serialised(rec.pendingId, () => putLocked(rec));
  }

  function putVideo(rec: VideoRecord): Promise<void> {
    if (!isValidMediaId(rec.pendingId) || !isValidMediaId(rec.inspectionId)) return Promise.reject(new MediaError('INVALID_ID'));
    return serialised(rec.pendingId, () => putVideoLocked(rec));
  }

  async function getRow(pendingId: string): Promise<MediaRow | null> {
    if (!isValidMediaId(pendingId)) return null;
    const raw = await rawRow(pendingId);
    return raw ? rowFromDb(raw) : null;
  }

  async function listRowsPage(filter: RowFilter = {}): Promise<RowPage> {
    const empty: RowPage = { rows: [], rawCount: 0, next: null };
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.inspectionId !== undefined) {
      if (!isValidMediaId(filter.inspectionId)) throw new MediaError('INVALID_ID');
      where.push('inspection_id = ?');
      params.push(filter.inspectionId);
    }
    if (filter.states !== undefined) {
      if (filter.states.length === 0) return empty;
      for (const state of filter.states) assertMediaState(state);
      where.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    if (filter.kinds !== undefined) {
      if (filter.kinds.length === 0) return empty;
      for (const kind of filter.kinds) if (!MEDIA_KINDS.includes(kind)) throw new MediaError('INVALID_RECORD');
      where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
      params.push(...filter.kinds);
    }
    if (filter.skipGivenUpAt !== undefined) {
      if (!Number.isInteger(filter.skipGivenUpAt)) throw new MediaError('INVALID_RECORD');
      where.push("NOT (state = 'failed' AND attempts >= ?)");
      params.push(filter.skipGivenUpAt);
    }
    if (filter.after !== undefined) {
      // The cursor may be the id of a row this store did not write, so only its shape is checked; it is only ever bound.
      if (!Number.isFinite(filter.after.createdAt) || !isText(filter.after.pendingId)) throw new MediaError('INVALID_RECORD');
      where.push('(created_at > ? OR (created_at = ? AND pending_id > ?))');
      params.push(filter.after.createdAt, filter.after.createdAt, filter.after.pendingId);
    }
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? DEFAULT_LIST_LIMIT), DEFAULT_LIST_LIMIT));
    const sql = `SELECT ${COLUMNS} FROM media${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, pending_id LIMIT ?`;
    const raws = await db.query<Record<string, unknown>>(sql, [...params, limit]);
    const rows: MediaRow[] = [];
    for (const raw of raws) {
      const row = rowFromDb(raw);
      if (row) rows.push(row);
    }
    const lastRaw = raws[raws.length - 1];
    const lastId = lastRaw?.pending_id;
    const lastAt = Number(lastRaw?.created_at);
    const next = lastRaw !== undefined && isText(lastId) && Number.isFinite(lastAt) ? { createdAt: lastAt, pendingId: lastId } : null;
    return { rows, rawCount: raws.length, next };
  }

  async function listRows(filter: RowFilter = {}): Promise<MediaRow[]> {
    return (await listRowsPage(filter)).rows;
  }

  return {
    put,
    putVideo,
    getRow,
    listRows,
    listRowsPage,

    get: async (pendingId) => {
      try {
        const row = await getRow(pendingId);
        return row ? recordFromRow(row) : null;
      } catch {
        return null;
      }
    },

    list: async (inspectionId) => {
      try {
        if (inspectionId !== undefined && !isValidMediaId(inspectionId)) return [];
        const rows = await listRows(inspectionId === undefined ? {} : { inspectionId });
        const records: PendingMediaRecord[] = [];
        for (const row of rows) {
          const record = recordFromRow(row);
          if (record) records.push(record);
        }
        return records;
      } catch {
        return [];
      }
    },

    delete: async (pendingId) => {
      if (!isValidMediaId(pendingId)) return;
      const raw = await rawRow(pendingId);
      if (!raw) return;
      const row = rowFromDb(raw);
      // A row this store did not write has no trustworthy path: only the row is removed.
      if (row) {
        try {
          await files.remove(row.path);
        } catch {
          // A file that is already gone is the goal; any other failure keeps the row so a later pass retries.
          const stillThere = await files.exists(row.path).catch(() => true);
          if (stillThere) throw new MediaError('DELETE_FAILED');
        }
      }
      await db.run('DELETE FROM media WHERE pending_id = ?', [pendingId]);
    },

    objectUrl: async (pendingId) => {
      try {
        const row = await getRow(pendingId);
        return row ? await files.displayUrl(row.path) : null;
      } catch {
        return null;
      }
    },

    markState: async (pendingId, state, patch) => {
      assertMediaState(state);
      if (!isValidMediaId(pendingId)) throw new MediaError('INVALID_ID');
      const sets = ['state = ?'];
      const params: unknown[] = [state];
      if (patch?.attempts !== undefined) {
        if (!Number.isInteger(patch.attempts) || patch.attempts < 0) throw new MediaError('INVALID_RECORD');
        sets.push('attempts = ?');
        params.push(patch.attempts);
      }
      if (patch !== undefined && patch.uploadedKey !== undefined) {
        if (patch.uploadedKey !== null && !isValidUploadedKey(patch.uploadedKey)) throw new MediaError('INVALID_RECORD');
        sets.push('uploaded_key = ?');
        params.push(patch.uploadedKey);
      }
      let condition = 'pending_id = ?';
      const where: unknown[] = [pendingId];
      if (patch?.ifState !== undefined) {
        assertMediaState(patch.ifState);
        condition += ' AND state = ?';
        where.push(patch.ifState);
      }
      const result = await db.run(`UPDATE media SET ${sets.join(', ')} WHERE ${condition}`, [...params, ...where]);
      return result.changes > 0;
    },

    fileUri: (row) => files.fileUri(row.path),
    fileExists: (row) => files.exists(row.path),
    fileSize: (row) => files.size(row.path),
  };
}
