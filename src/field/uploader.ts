import type * as Y from 'yjs';
import type { MediaFileResult, MediaUploader, PendingMediaRecord } from '@inspectorhub/field-ui';
import { realTimers, type TimerPort } from '../collab/timers';
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
 *  - a photo of an item is written to the device store and sent by the background uploader (`uploadDetailed` joins an
 *    upload of the same photo that is already running, so the editor's own drain and the app's reconciler never send it
 *    twice);
 *  - a photo of a custom defect row cannot enter the store, and a crop or an annotation must not reach the background
 *    uploader (it refuses those kinds for good and would mark the row failed): all three are foreground Bearer
 *    requests (`uploader-foreground.ts`).
 *
 * What happens to the bytes when an online upload fails (item photos):
 *  - the row this call created is KEPT, and a pending entry is appended to the results document (through `withDoc`,
 *    after the row exists, never before), exactly the state the editor's own offline path leaves. The reconciler or the
 *    editor's drain sends it later under the same `pendingId`, hence the same key, so a repeat never makes a second file.
 *    The answer is `{ ok: false, error, kept: true }`;
 *  - a failure that no retry can mend and that leaves no bytes to keep (the file is gone, the row is not ours) deletes
 *    the row this call created, as before; a blocked inspection's row is the quarantine's or the purge's;
 *  - when the entry cannot be written the bytes still stay and the answer says so, without `kept`: the person is never
 *    told the photo is in the inspection when it is not;
 *  - when the device store cannot even take the bytes (disk or database trouble) the photo is sent once, straight to the
 *    engine. A policy refusal (too large, wrong type, empty, blocked) is never kept or retried that way.
 *
 * Who removes the device row after a SUCCESS:
 *  - a row THIS call created is removed when the call ends;
 *  - a row that was already there (the editor queued it offline and its drain or the reconciler is now sending it) is
 *    left alone: the editor swaps the document entry to the real key first and deletes the row after. Deleting it here
 *    would come before that swap and a stop in between would lose the key. Its entry is the editor's, so a failure
 *    appends nothing for it.
 *
 * A photo of a custom defect row cannot enter the store, and a crop or an annotation must not reach the background
 * uploader: they are foreground Bearer requests and keep nothing when they fail.
 *
 * It never throws: every failure is `{ ok: false, error }` (plus `kept` when the bytes were kept) with one of the fixed sentences.
 */

export interface UploaderDeps {
  isBlocked: IsBlocked;
  store: Pick<MediaStore, 'getRow' | 'put' | 'delete'>;
  native: Pick<NativeUploader, 'uploadDetailed'>;
  /** Runs a function against the results document of an inspection; rejects with `BLOCKED` for a blocked inspection. */
  withDoc: WithDoc;
  foreground: ForegroundUploads;
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
      return MESSAGES.photoTooLarge;
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
      return MESSAGES.photoTooLarge;
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

  /** A read-only look for the entry of a row that was already queued. A document that cannot be read counts as no entry. */
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
    const direct = await deps.foreground.itemPhotoDirect(rec);
    return direct.ok ? direct : fail(storeFailureMessage(error));
  }

  async function itemPhoto(inspectionId: string, rec: Extract<PendingMediaRecord, { kind: 'photo' }>): Promise<Result> {
    const existing = await deps.store.getRow(rec.pendingId);
    const created = existing === null;
    if (created) {
      try {
        await deps.store.put(rec);
      } catch (error) {
        return await afterStoreFailure(rec, error);
      }
    } else if (existing.inspectionId !== inspectionId || existing.kind !== 'photo') {
      // The id belongs to another record: nothing here may be sent or removed under it.
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
        return rec.meta.targetType === 'defect' ? deps.foreground.defectPhoto(rec) : itemPhoto(inspectionId, rec);
      case 'crop':
        return deps.foreground.crop(rec, doc);
      case 'annotate':
        return deps.foreground.annotate(rec, doc);
      default:
        // A kind this build does not know (a record from a newer editor): nothing is sent for it.
        return fail(MESSAGES.invalidValue);
    }
  }

  return (inspectionId, doc) => ({
    upload: async (rec) => {
      try {
        if (rec.inspectionId !== inspectionId) return fail(MESSAGES.unavailable);
        if (await deps.isBlocked(inspectionId)) return fail(MESSAGES.blocked);
        return await route(inspectionId, doc, rec);
      } catch {
        // Nothing of the error is shown: it may carry a path or a server's words.
        return fail(MESSAGES.requestFailed);
      }
    },
  });
}
