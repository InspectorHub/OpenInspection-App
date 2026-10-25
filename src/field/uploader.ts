import type * as Y from 'yjs';
import type { MediaUploader, PendingMediaRecord } from '@inspectorhub/field-ui';
import { isMediaError } from '../media/errors';
import type { NativeUploader, UploadFailureCode } from '../media/native-uploader';
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
 * Who removes the device row:
 *  - a row THIS call created (the online path: the editor handed over a photo with bytes and nothing queued it) is
 *    removed when the call ends, success or failure. Nothing in the document refers to it, so a row left behind would
 *    be sent again by the reconciler, and a failed upload is the person's to retry, as on the web;
 *  - a row that was already there (the editor queued it offline and its drain or the reconciler is now sending it) is
 *    left alone: the editor swaps the document entry to the real key first and deletes the row after. Deleting it here
 *    would come before that swap and a stop in between would lose the key.
 *  - a row of a blocked inspection is never touched: the quarantine or the purge owns it.
 *
 * It never throws: every failure is `{ ok: false, error }` with one of the fixed sentences.
 */

export interface UploaderDeps {
  isBlocked: IsBlocked;
  store: Pick<MediaStore, 'getRow' | 'put' | 'delete'>;
  native: Pick<NativeUploader, 'uploadDetailed'>;
  foreground: ForegroundUploads;
  /** A row that could not be removed after its upload. The upload itself still stands. */
  onError?(error: unknown): void;
}

type Result = Awaited<ReturnType<MediaUploader['upload']>>;

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

export function createUploaderFactory(deps: UploaderDeps): (inspectionId: string, doc: Y.Doc | null) => MediaUploader {
  async function itemPhoto(inspectionId: string, rec: PendingMediaRecord): Promise<Result> {
    const existing = await deps.store.getRow(rec.pendingId);
    const created = existing === null;
    if (created) {
      try {
        await deps.store.put(rec);
      } catch (error) {
        return fail(storeFailureMessage(error));
      }
    } else if (existing.inspectionId !== inspectionId || existing.kind !== 'photo') {
      // The id belongs to another record: nothing here may be sent or removed under it.
      return fail(MESSAGES.photoNotPrepared);
    }
    const outcome = await deps.native.uploadDetailed({ pendingId: rec.pendingId, inspectionId });
    // A blocked inspection's row is the quarantine's or the purge's to deal with.
    if (created && !(!outcome.ok && outcome.code === 'BLOCKED')) {
      try {
        await deps.store.delete(rec.pendingId);
      } catch (error) {
        deps.onError?.(error);
      }
    }
    return outcome.ok ? { ok: true, key: outcome.key } : fail(uploadFailureMessage(outcome.code));
  }

  async function route(inspectionId: string, doc: Y.Doc | null, rec: PendingMediaRecord): Promise<Result> {
    switch (rec.kind) {
      case 'photo':
        return rec.meta.targetType === 'defect' ? deps.foreground.defectPhoto(rec) : itemPhoto(inspectionId, rec);
      case 'crop':
        return deps.foreground.crop(rec, doc);
      case 'annotate':
        return deps.foreground.annotate(rec, doc);
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
