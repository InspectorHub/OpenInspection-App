import type * as Y from 'yjs';
import type { MediaFileResult, MediaUploader, PendingMediaRecord } from '@inspectorhub/field-ui';
import type { TimerPort } from '../collab/timers';
import { defectTargetOf } from '../media/defect-target';
import { isMediaError } from '../media/errors';
import { sniffMediaKind } from '../media/media-types';
import type { NativeUploader, UploadFailureCode } from '../media/native-uploader';
import type { WithDoc } from '../media/pending-doc';
import type { MediaStore } from '../media/store';
import type { IsBlocked } from '../offline/blocked';
import type { Files } from '../platform/files';
import type { PhotoDiagnostic } from '../app/diagnostics';
import { MESSAGES } from './messages';
import { createEntryOps } from './uploader-entries';
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
 * The entry comes FIRST for a photo of an item: as soon as the row exists and before the upload starts, a pending entry is
 * appended to the results document (the same entry the editor's own offline path writes). A process killed while the upload
 * is out then leaves the three things that belong together: the row on the device, the entry in the document and, once the
 * background upload finishes after the restart, the file on the server. The reconciler swaps the entry for the key and only
 * then removes the file. Without the entry first, a kill left a row and a server file that nothing in the document named, and
 * the app cannot tell that apart from a photo the person deleted on purpose. On success the entry is swapped for the key before
 * the answer; the editor then attaches the same key, which the document merges by key instead of adding a second entry.
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
  /**
   * Receives one fixed code whenever a photo is answered as a plain failure that is not a policy refusal (so the person
   * is told it failed and it is not kept). Codes only: never a name, a path, a token or a message.
   */
  onDiagnostic?(code: PhotoDiagnostic): void;
  /** Whether the OS reports a network link; only added to the diagnostic code. */
  isOnline?(): boolean;
  /**
   * Called once for a photo whose row this call has just created, before the upload starts: where a copy for the person's gallery
   * is made when they asked for one. It decides for itself whether to copy, must never throw, and changes nothing about the answer.
   */
  copyToGallery?(rec: Extract<PendingMediaRecord, { kind: 'photo' }>): Promise<void>;
}

/**
 * What `MediaUploader.upload` answers. `kept` says the bytes are on the device AND the document names them; it is not
 * part of the editor package's type before 0.3.0, where an extra property on a failure is ignored.
 */
type Result = { ok: true; key: string; result?: MediaFileResult } | { ok: false; error: string; kept?: true; permanent?: true };

const fail = (error: string): Result => ({ ok: false, error });

/** Where a photo was answered as a plain failure; the first part of its diagnostic code. */
type LossSite = 'blocked_at_start' | 'blocked_outcome' | 'unexpected_throw' | 'store_refused' | 'store_trouble_direct_failed' | 'nothing_to_keep' | 'row_mismatch' | 'entry_missing_for_queued' | 'entry_failed' | 'entry_blocked';

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

/**
 * A refusal of the file itself. The editor words it from the stable code, once, and `permanent` tells it that nothing is
 * left waiting to be saved: it must not also report a failed save. (The editor checks the same two things before it
 * sends a file, so this is the answer for a file that got past that check and was still refused here.)
 */
const refusedFile = (code: 'TOO_LARGE' | 'UNSUPPORTED_TYPE'): Result => ({ ok: false, error: code, permanent: true });

function storeFailure(error: unknown): Result {
  if (!isMediaError(error)) return fail(MESSAGES.photoNotPrepared);
  switch (error.code) {
    case 'TOO_LARGE':
    case 'UNSUPPORTED_TYPE':
      return refusedFile(error.code);
    case 'BLOCKED':
      return fail(MESSAGES.blocked);
    default:
      return fail(MESSAGES.photoNotPrepared);
  }
}

/**
 * The photo with its declared type corrected to what its leading bytes really are. A browser declares the type from the
 * file NAME, so a real PNG called photo.jpg arrives as image/jpeg. The store keeps a file under its declared type's
 * extension and the desktop main process refuses bytes that do not match that extension, so a valid photo with a wrong
 * label would fail to write. The editor already admitted it by its bytes, and the server stores by bytes too, so the
 * label is fixed here, before the first `store.put`, and the photo is stored under its real type, never refused.
 *
 * Bytes that are not a supported image (sniff finds nothing) are left exactly as they are: this does not decide to refuse
 * them. If the store then cannot write them, the old behaviour stands (one direct upload, where the server decides).
 */
async function withRealType(rec: Extract<PendingMediaRecord, { kind: 'photo' }>): Promise<Extract<PendingMediaRecord, { kind: 'photo' }>> {
  let kind: ReturnType<typeof sniffMediaKind>;
  try {
    kind = sniffMediaKind(new Uint8Array(await rec.blob.slice(0, 4096).arrayBuffer()));
  } catch {
    return rec;
  }
  if (kind === null) return rec;
  const real = `image/${kind}`;
  const declared = (rec.blob.type.split(';')[0] ?? '').trim().toLowerCase();
  return declared === real ? rec : { ...rec, blob: new Blob([rec.blob], { type: real }) };
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
  const entries = createEntryOps({ withDoc: deps.withDoc, timers: deps.timers, onError: deps.onError });

  /** Tells the diagnostic sink, once, that a photo was answered as a plain failure. Never throws. */
  function lost(site: LossSite, detail: string): void {
    try {
      let online = 'unknown';
      try {
        if (deps.isOnline !== undefined) online = deps.isOnline() ? 'online' : 'offline';
      } catch {
        // The link state is only a detail of the code.
      }
      deps.onDiagnostic?.(`photo_not_kept:${site}:${detail}:${online}`);
    } catch {
      // A failing reporter changes nothing about the answer.
    }
  }

  async function removeRow(pendingId: string): Promise<void> {
    try {
      await deps.store.delete(pendingId);
    } catch (error) {
      deps.onError?.(error);
    }
  }

  /**
   * The device store refused the bytes. Disk, database or write trouble gets one direct upload and is never permanent;
   * only the store's own decision about the type or size (a policy refusal) is permanent, and that is never sent.
   */
  async function afterStoreFailure(rec: Extract<PendingMediaRecord, { kind: 'photo' }>, error: unknown): Promise<Result> {
    const code = isMediaError(error) ? error.code : 'UNKNOWN';
    if (!isStoreTrouble(error)) {
      const refused = storeFailure(error);
      if (!refused.ok && refused.permanent !== true) lost('store_refused', code);
      return refused;
    }
    const direct = await (rec.meta.targetType === 'defect' ? deps.foreground.defectPhoto(rec) : deps.foreground.itemPhotoDirect(rec));
    if (direct.ok) return direct;
    lost('store_trouble_direct_failed', code);
    return storeFailure(error);
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
      lost('row_mismatch', 'NONE');
      return fail(MESSAGES.photoNotPrepared);
    }
    if (created && deps.copyToGallery !== undefined) {
      // Started now, NOT waited for: on iOS the first save asks the person for permission and waits for the answer, and neither the document
      // entry below nor the upload may wait for that. The copy reads the photo as it is stored, which is what it is handed here.
      // A copy for the gallery is a convenience: whatever goes wrong with it, the photo is uploaded as usual.
      const copy = deps.copyToGallery;
      void (async () => {
        try {
          await copy(rec);
        } catch (error) {
          deps.onError?.(error);
        }
      })();
    }
    // Write-ahead: the entry goes into the document before the upload starts (see the head of this file). A row that was
    // already queued has its entry from the editor; a defect photo has none by design. When the entry cannot be written
    // the upload still goes on and the old path stands: the editor attaches the key when the upload answers.
    let entryWritten = false;
    let entryFailure: string | null = null;
    if (created && !isDefect) {
      const first = await entries.add(inspectionId, rec);
      if (first === 'blocked') {
        lost('entry_blocked', 'NONE');
        return fail(MESSAGES.blocked);
      }
      entryWritten = first === 'added';
      if (first !== 'added') entryFailure = first.failed;
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
      if (entryWritten) {
        const placed = await entries.swap(inspectionId, rec.pendingId, outcome.key);
        // The person deleted the photo while it uploaded: the success must not bring it back, and nothing is deleted here.
        if (placed === 'removed') return fail(MESSAGES.photoKeptNotAdded);
        // The document could not be reached just now: the entry still names the photo and the row is `uploaded`, so the
        // reconciler swaps the entry and removes the file. Answering ok would make the editor add a second entry.
        if (placed === 'later') return { ok: false, error: MESSAGES.unreachable, kept: true };
      }
      if (created) await removeRow(rec.pendingId);
      return { ok: true, key: outcome.key };
    }
    const error = uploadFailureMessage(outcome.code);
    // A blocked inspection's row is the quarantine's or the purge's to deal with.
    if (outcome.code === 'BLOCKED') {
      lost('blocked_outcome', outcome.code);
      return fail(error);
    }
    if (leavesNothingToKeep(outcome.code, outcome.retryable)) {
      // The entry written first goes with the row. When it cannot be taken back the row stays, so the document never names a
      // photo that has no row behind it.
      if (created && (!entryWritten || (await entries.remove(inspectionId, rec)))) await removeRow(rec.pendingId);
      lost('nothing_to_keep', outcome.code);
      return fail(error);
    }
    // A kept refusal that no retry can mend (a native TOO_LARGE or a permanent 4xx) is a `failed` row at the maximum
    // attempts: it never retries on its own, so no notice about it may promise an automatic upload.
    // A defect photo's row is the whole record: there is no entry to write, and the reconciler attaches the key.
    if (isDefect) return { ok: false, error, kept: true };
    // A queued row's entry is the editor's, and is never written or repaired here (a version restore may have removed
    // it on purpose): `kept` is claimed only when the document really holds it.
    if (!created) {
      if (await entries.exists(inspectionId, rec)) return { ok: false, error, kept: true };
      lost('entry_missing_for_queued', outcome.code);
      return fail(error);
    }
    if (entryWritten) return { ok: false, error, kept: true };
    // The entry could not be written before the upload either, and it is not tried a second time: the bytes stay, and the
    // answer says they were not added to the inspection.
    lost('entry_failed', `${entryFailure ?? 'UNKNOWN'}:${outcome.code}`);
    return fail(MESSAGES.photoKeptNotAdded);
  }

  async function route(inspectionId: string, doc: Y.Doc | null, rec: PendingMediaRecord): Promise<Result> {
    switch (rec.kind) {
      case 'photo':
        return storedPhoto(inspectionId, await withRealType(rec));
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
        if (await deps.isBlocked(inspectionId)) {
          lost('blocked_at_start', 'NONE');
          return fail(MESSAGES.blocked);
        }
        const result = await route(inspectionId, doc, rec);
        if (!result.ok && result.kept === true) announceKept(inspectionId, rec);
        return result;
      } catch {
        // Nothing of the error is shown: it may carry a path or a server's words.
        lost('unexpected_throw', 'NONE');
        return fail(MESSAGES.requestFailed);
      }
    },
  });
}
