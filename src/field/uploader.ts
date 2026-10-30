import type * as Y from 'yjs';
import type { MediaFileResult, MediaUploader, PendingMediaRecord } from '@inspectorhub/field-ui';
import { realTimers, type TimerPort } from '../collab/timers';
import { defectTargetOf } from '../media/defect-target';
import { isMediaError, MediaError } from '../media/errors';
import type { NativeUploader, UploadFailureCode } from '../media/native-uploader';
import { appendPendingInDoc, hasPendingEntryInDoc } from '../media/pending-doc-append';
import type { WithDoc } from '../media/pending-doc';
import type { MediaStore } from '../media/store';
import type { IsBlocked } from '../offline/blocked';
import type { Files } from '../platform/files';
import { MESSAGES } from './messages';
import type { ForegroundUploads } from './uploader-foreground';

/**
 * `FieldDataSource.media.uploader(inspectionId, doc)`: the one object the editor uploads a photo through, whatever the
 * photo is. Where each kind goes:
 *
 *  - a photo, of an item or of a defect row, is written to the device store and sent by the background uploader
 *    (`uploadDetailed` joins an upload of the same photo that is already running, so the editor's own drain and the
 *    app's reconciler never send it twice);
 *  - a crop or an annotation must not reach the background uploader (it refuses those kinds for good and would mark the
 *    row failed): both are foreground Bearer requests (`uploader-foreground.ts`).
 *
 * What happens to the bytes when an online upload fails (photos):
 *  - the row this call created is KEPT. For an item photo a pending entry is appended to the results document (through
 *    `withDoc`, after the row exists, never before), exactly the state the editor's own offline path leaves. The reconciler
 *    or the editor's drain sends it later under the same `pendingId`, hence the same key, so a repeat never makes a second
 *    file. A photo of a defect row has NO entry in the document (the defect is named by the row's meta, not by an item), so
 *    nothing is appended: the row is invisible to the editor's own queue (`store.ts`), and when the reconciler has
 *    uploaded it, it adds `{ key }` to the defect's `photos`. The answer is `{ ok: false, error, kept: true }`;
 *  - a failure that no retry can mend and that leaves no bytes to keep (the file is gone, the row is not ours) deletes
 *    the row this call created, as before; a blocked inspection's row is the quarantine's or the purge's;
 *  - when the entry cannot be written the bytes still stay and the answer says so, without `kept`: the person is never
 *    told the photo is in the inspection when it is not;
 *  - when the device store cannot even take the bytes (disk or database trouble) the photo is sent once, straight to the
 *    engine (a defect photo with its defect, the editor then attaches the key). A policy refusal (too large, wrong type, empty, blocked) is never kept or retried that way.
 *
 * Who removes the device row after a SUCCESS:
 *  - a row THIS call created is removed when the call ends;
 *  - a row that was already there (the editor queued it offline and its drain or the reconciler is now sending it) is
 *    left alone: the editor swaps the document entry to the real key first and deletes the row after. Deleting it here
 *    would come before that swap and a stop in between would lose the key. Its entry is the editor's, so a failure
 *    appends nothing for it.
 *
 * A crop or an annotation is a foreground Bearer request and keeps nothing when it fails.
 *
 * It never throws: every failure is `{ ok: false, error }` (plus `kept` when the bytes were kept). `TOO_LARGE` is a stable
 * reason code for the editor's localized photo-size guidance; all other returned errors remain fixed safe sentences.
 */

export interface UploaderDeps {
  isBlocked: IsBlocked;
  store: Pick<MediaStore, 'getRow' | 'put' | 'delete'>;
  native: Pick<NativeUploader, 'uploadDetailed'>;
  /** Runs a function against the results document of an inspection; rejects with `BLOCKED` for a blocked inspection. */
  withDoc: WithDoc;
  foreground: ForegroundUploads;
  /** Called once for every answer that carries `kept`: the photo is on the device and the document names it. Never throws into the answer. */
  onKept?(inspectionId: string, kind: 'item' | 'defect'): void;
  /** Something that did not stop the answer: a row that could not be removed, an entry that could not be written. */
  onError?(error: unknown): void;
  /** Spaces the tries to write the document entry while the editor's document is not available. */
  timers?: TimerPort;
}

/**
 * What `MediaUploader.upload` answers. `kept` says the bytes are on the device AND the document names them; it is not
 * part of the editor package's type before 0.3.0, where an extra property on a failure is ignored.
 */
type Result = { ok: true; key: string; result?: MediaFileResult } | { ok: false; error: string; kept?: true };

const ENTRY_TRIES = 3;
const ENTRY_RETRY_MS = 500;

const fail = (error: string): Result => ({ ok: false, error });

function uploadFailureMessage(code: UploadFailureCode): string {
  switch (code) {
    case 'LOCKED':
      return MESSAGES.deviceLocked;
    case 'AUTH':
      return MESSAGES.sessionExpired;
    case 'UPGRADE':
      return MESSAGES.upgradeRequired;
    case 'BLOCKED':
      return MESSAGES.blocked;
    case 'TOO_LARGE':
      return 'TOO_LARGE';
    case 'NETWORK':
    case 'TIMEOUT':
      return MESSAGES.unreachable;
    default:
      return MESSAGES.photoUploadFailed;
  }
}

function storeFailureMessage(error: unknown): string {
  if (!isMediaError(error)) return MESSAGES.photoNotPrepared;
  switch (error.code) {
    case 'TOO_LARGE':
      return 'TOO_LARGE';
    case 'UNSUPPORTED_TYPE':
      return MESSAGES.photoTypeUnsupported;
    case 'BLOCKED':
      return MESSAGES.blocked;
    default:
      return MESSAGES.photoNotPrepared;
  }
}

/** The bytes of a stored record, read back from its file; null when the row or the file cannot be read. */
export function createStoredBlobReader(store: Pick<MediaStore, 'getRow'>, files: Pick<Files, 'read'>): (pendingId: string) => Promise<Blob | null> {
  return async (pendingId) => {
    try {
      const row = await store.getRow(pendingId);
      if (row === null) return null;
      const bytes = await files.read(row.path);
      return new Blob([new Uint8Array(bytes)], { type: row.contentType });
    } catch {
      return null;
    }
  };
}

/** Failures after which there is nothing worth keeping: no bytes to send, or a row that is not this record's. */
function leavesNothingToKeep(code: UploadFailureCode, retryable: boolean): boolean {
  return code === 'NOT_FOUND' || code === 'INVALID' || code === 'UNSUPPORTED_KIND' || (code === 'FILE' && !retryable);
}

/** The reasons the device store can fail for that are about the disk or the database, not about the photo. */
function isStoreTrouble(error: unknown): boolean {
  return isMediaError(error) && (error.code === 'WRITE_FAILED' || error.code === 'DB_FAILED' || error.code === 'DISK_FULL');
}

export function createUploaderFactory(deps: UploaderDeps): (inspectionId: string, doc: Y.Doc | null) => MediaUploader {
  const timers = deps.timers ?? realTimers;
  const pause = (ms: number): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, ms));

  /** Adds the pending entry of a kept photo. 'added' also covers an entry that was already there. */
  async function addEntry(inspectionId: string, rec: Extract<PendingMediaRecord, { kind: 'photo' }>): Promise<'added' | 'blocked' | 'failed'> {
    for (let attempt = 1; attempt <= ENTRY_TRIES; attempt += 1) {
      try {
        const answer = await deps.withDoc(inspectionId, (doc) => appendPendingInDoc(doc, rec.meta.findingKey, rec.meta.itemId, rec.pendingId));
        if (answer === 'invalid_key') {
          deps.onError?.(new MediaError('INVALID_RECORD'));
          return 'failed';
        }
        return 'added';
      } catch (error) {
        if (isMediaError(error) && error.code === 'BLOCKED') return 'blocked';
        if (isMediaError(error) && error.code === 'DOC_BUSY' && attempt < ENTRY_TRIES) {
          await pause(ENTRY_RETRY_MS);
          continue;
        }
        deps.onError?.(error);
        return 'failed';
      }
    }
    return 'failed';
  }

  /**
   * A read-only look for the entry of a row that was already queued. A document that cannot be read counts as no entry.
   * A second call for a row whose first call is still on its way to writing the entry can answer a plain failure here,
   * before that entry lands: it only ever under-claims (the person is told less than is true), it never claims `kept`
   * falsely, and it never writes.
   */
  async function entryExists(inspectionId: string, rec: Extract<PendingMediaRecord, { kind: 'photo' }>): Promise<boolean> {
    try {
      return await deps.withDoc(inspectionId, (doc) => hasPendingEntryInDoc(doc, rec.meta.findingKey, rec.meta.itemId, rec.pendingId));
    } catch (error) {
      if (!(isMediaError(error) && error.code === 'BLOCKED')) deps.onError?.(error);
      return false;
    }
  }

  async function removeRow(pendingId: string): Promise<void> {
    try {
      await deps.store.delete(pendingId);
    } catch (error) {
      deps.onError?.(error);
    }
  }

  /** The device store refused the bytes. Disk or database trouble gets one direct upload; a policy refusal does not. */
  async function afterStoreFailure(rec: Extract<PendingMediaRecord, { kind: 'photo' }>, error: unknown): Promise<Result> {
    if (!isStoreTrouble(error)) return fail(storeFailureMessage(error));
    const direct = await (rec.meta.targetType === 'defect' ? deps.foreground.defectPhoto(rec) : deps.foreground.itemPhotoDirect(rec));
    return direct.ok ? direct : fail(storeFailureMessage(error));
  }

  async function storedPhoto(inspectionId: string, rec: Extract<PendingMediaRecord, { kind: 'photo' }>): Promise<Result> {
    const isDefect = rec.meta.targetType === 'defect';
    const existing = await deps.store.getRow(rec.pendingId);
    const created = existing === null;
    if (created) {
      try {
        await deps.store.put(rec);
      } catch (error) {
        return await afterStoreFailure(rec, error);
      }
    } else if (existing.inspectionId !== inspectionId || existing.kind !== 'photo' || (defectTargetOf(existing) !== null) !== isDefect) {
      // The id belongs to another record (or to a photo of the other sort): nothing here may be sent or removed under it.
      return fail(MESSAGES.photoNotPrepared);
    }
    let outcome: Awaited<ReturnType<NativeUploader['uploadDetailed']>>;
    try {
      outcome = await deps.native.uploadDetailed({ pendingId: rec.pendingId, inspectionId });
    } catch {
      // Nothing of the error is shown. What happened is unknown, so it is treated like any retryable failure: the
      // bytes are on the device and the reconciler will try again.
      outcome = { ok: false, code: 'PLUGIN', retryable: true, retryAfterMs: null, halt: false };
    }
    if (outcome.ok) {
      if (created) await removeRow(rec.pendingId);
      return { ok: true, key: outcome.key };
    }
    const error = uploadFailureMessage(outcome.code);
    // A blocked inspection's row is the quarantine's or the purge's to deal with.
    if (outcome.code === 'BLOCKED') return fail(error);
    if (leavesNothingToKeep(outcome.code, outcome.retryable)) {
      if (created) await removeRow(rec.pendingId);
      return fail(error);
    }
    // A kept refusal that no retry can mend (a native TOO_LARGE or a permanent 4xx) is a `failed` row at the maximum
    // attempts: it never retries on its own, so no notice about it may promise an automatic upload.
    // A defect photo's row is the whole record: there is no entry to write, and the reconciler attaches the key.
    if (isDefect) return { ok: false, error, kept: true };
    // A queued row's entry is the editor's, and is never written or repaired here (a version restore may have removed
    // it on purpose): `kept` is claimed only when the document really holds it.
    if (!created) return (await entryExists(inspectionId, rec)) ? { ok: false, error, kept: true } : fail(error);
    switch (await addEntry(inspectionId, rec)) {
      case 'added':
        return { ok: false, error, kept: true };
      case 'blocked':
        return fail(MESSAGES.blocked);
      default:
        return fail(MESSAGES.photoKeptNotAdded);
    }
  }

  async function route(inspectionId: string, doc: Y.Doc | null, rec: PendingMediaRecord): Promise<Result> {
    switch (rec.kind) {
      case 'photo':
        return storedPhoto(inspectionId, rec);
      case 'crop':
        return deps.foreground.crop(rec, doc);
      case 'annotate':
        return deps.foreground.annotate(rec, doc);
      default:
        // A kind this build does not know (a record from a newer editor): nothing is sent for it.
        return fail(MESSAGES.invalidValue);
    }
  }

  function announceKept(inspectionId: string, rec: PendingMediaRecord): void {
    try {
      deps.onKept?.(inspectionId, rec.kind === 'photo' && rec.meta.targetType === 'defect' ? 'defect' : 'item');
    } catch (error) {
      deps.onError?.(error);
    }
  }

  return (inspectionId, doc) => ({
    upload: async (rec) => {
      try {
        if (rec.inspectionId !== inspectionId) return fail(MESSAGES.unavailable);
        if (await deps.isBlocked(inspectionId)) return fail(MESSAGES.blocked);
        const result = await route(inspectionId, doc, rec);
        if (!result.ok && result.kept === true) announceKept(inspectionId, rec);
        return result;
      } catch {
        // Nothing of the error is shown: it may carry a path or a server's words.
        return fail(MESSAGES.requestFailed);
      }
    },
  });
}
