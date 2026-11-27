import type * as Y from 'yjs';
import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { isMediaError } from '../media/errors';
import type { MediaStore } from '../media/store';
import { MESSAGES } from './messages';
import type { ForegroundUploads } from './uploader-foreground';

/**
 * A crop or an annotation, kept like a photo. The record (operation + bytes) is written to the device store first,
 * then sent in the foreground. A failure a later try can mend — the document ahead of the server, no connection, a
 * server refusal — answers `kept`, so the editor's drain sends it again when the document has caught up and the
 * person is told it is waiting, not lost. A failure no retry can mend (the photo is gone, the bytes will never fit)
 * answers `permanent` and the row goes with it: the drain drops the record and clears the pending edit from the
 * document. Bytes the store cannot read are neither kept nor permanent: there is nothing to send and nothing to drop.
 * Disk or database trouble keeps nothing either: the foreground send is the only chance, as for a photo.
 *
 * Two uploads of the same record at once send once: the second joins the first instead of baking the same edit twice.
 * The small failure helpers mirror the photo path in `uploader.ts`; the policy they carry (which store errors are
 * trouble, which refusals are permanent) is the same in both places.
 */

export type DerivativeResult = { ok: true; key: string } | { ok: false; error: string; kept?: true; permanent?: true };

export interface DerivativeDeps {
  store: Pick<MediaStore, 'getRow' | 'put' | 'delete'>;
  foreground: ForegroundUploads;
  /** Something that did not stop the answer: a row that could not be removed. */
  onError?(error: unknown): void;
}

type Derivative = Extract<PendingMediaRecord, { kind: 'crop' | 'annotate' }>;

export function createDerivativeUploads(deps: DerivativeDeps): (inspectionId: string, rec: Derivative, doc: Y.Doc | null) => Promise<DerivativeResult> {
  const fail = (error: string): DerivativeResult => ({ ok: false, error });

  /** A refusal of the file itself: the editor words it from the stable code, and `permanent` says nothing is left waiting. */
  const refusedFile = (code: 'TOO_LARGE' | 'UNSUPPORTED_TYPE'): DerivativeResult => ({ ok: false, error: code, permanent: true });

  /** The reasons the device store can fail for that are about the disk or the database, not about the record. */
  function isStoreTrouble(error: unknown): boolean {
    return isMediaError(error) && (error.code === 'WRITE_FAILED' || error.code === 'DB_FAILED' || error.code === 'DISK_FULL');
  }

  async function removeRow(pendingId: string): Promise<void> {
    try {
      await deps.store.delete(pendingId);
    } catch (error) {
      deps.onError?.(error);
    }
  }

  async function storedDerivative(inspectionId: string, rec: Derivative, doc: Y.Doc | null): Promise<DerivativeResult> {
    const existing = await deps.store.getRow(rec.pendingId);
    const created = existing === null;
    let stored = !created;
    if (created) {
      try {
        await deps.store.put(rec);
        stored = true;
      } catch (error) {
        if (!isMediaError(error)) return fail(MESSAGES.photoNotPrepared);
        switch (error.code) {
          case 'TOO_LARGE':
          case 'UNSUPPORTED_TYPE':
            return refusedFile(error.code);
          case 'EMPTY':
            return fail(MESSAGES.photoNotPrepared);
          default:
            if (!isStoreTrouble(error)) return fail(MESSAGES.photoNotPrepared);
            break;
        }
      }
    } else if (existing.inspectionId !== inspectionId || existing.kind !== rec.kind) {
      // The id belongs to another record: nothing here may be sent or removed under it.
      return fail(MESSAGES.photoNotPrepared);
    }
    const result = rec.kind === 'crop' ? await deps.foreground.crop(rec, doc) : await deps.foreground.annotate(rec, doc);
    if (result.ok) {
      if (created && stored) await removeRow(rec.pendingId);
      return result;
    }
    if (result.permanent === true) {
      if (created && stored) await removeRow(rec.pendingId);
      return result;
    }
    // The bytes could not be read from the device: claiming them kept would be false, and there is nothing to send.
    if (result.error === MESSAGES.photoNotPrepared) return result;
    if (!stored) return result;
    return { ...result, kept: true };
  }

  const inFlight = new Map<string, Promise<DerivativeResult>>();
  return (inspectionId, rec, doc) => {
    const running = inFlight.get(rec.pendingId);
    if (running !== undefined) return running;
    const work = storedDerivative(inspectionId, rec, doc);
    inFlight.set(rec.pendingId, work);
    return work.finally(() => {
      inFlight.delete(rec.pendingId);
    });
  };
}
