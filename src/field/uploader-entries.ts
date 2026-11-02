import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import { realTimers, type TimerPort } from '../collab/timers';
import { isMediaError, MediaError } from '../media/errors';
import { appendPendingInDoc, hasPendingEntryInDoc, removePendingInDoc } from '../media/pending-doc-append';
import { resolvePendingInDoc, type WithDoc } from '../media/pending-doc';

type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;

const ENTRY_TRIES = 3;
const ENTRY_RETRY_MS = 500;

export interface EntryDeps {
  /** Runs a function against the results document of an inspection; rejects with `BLOCKED` for a blocked inspection. */
  withDoc: WithDoc;
  /** Spaces the tries to write the document entry while the editor's document is not available. */
  timers?: TimerPort;
  /** Something that did not stop the answer: an entry that could not be written. */
  onError?(error: unknown): void;
}

/** What the uploader does to the pending entry of a photo in the results document. */
export interface EntryOps {
  /** Adds the pending entry of a photo. 'added' also covers an entry that was already there. */
  add(inspectionId: string, rec: Photo): Promise<'added' | 'blocked' | { failed: string }>;
  /**
   * Swaps the pending entry written first for the key of the uploaded photo. 'placed': the document now holds the key.
   * 'removed': the entry is gone (the person deleted the photo while it uploaded). 'later': the document could not be
   * reached; the entry is still there for the reconciler to swap.
   */
  swap(inspectionId: string, pendingId: string, key: string): Promise<'placed' | 'removed' | 'later'>;
  /**
   * Takes back the entry written first, when the upload left nothing to keep. Never throws. True when the document no longer
   * holds the entry (it was removed or was never there); false when the document could not be reached, so the entry may
   * still be there and the caller must keep the row it belongs to.
   */
  remove(inspectionId: string, rec: Photo): Promise<boolean>;
  /**
   * A read-only look for the entry of a row that was already queued. A document that cannot be read counts as no entry.
   * A second call for a row whose first call is still on its way to writing the entry can answer a plain failure here,
   * before that entry lands: it only ever under-claims (the person is told less than is true), it never claims `kept`
   * falsely, and it never writes.
   */
  exists(inspectionId: string, rec: Photo): Promise<boolean>;
}

export function createEntryOps(deps: EntryDeps): EntryOps {
  const timers = deps.timers ?? realTimers;
  const pause = (ms: number): Promise<void> => new Promise((resolve) => timers.setTimeout(resolve, ms));

  return {
    async add(inspectionId, rec) {
      for (let attempt = 1; attempt <= ENTRY_TRIES; attempt += 1) {
        try {
          const answer = await deps.withDoc(inspectionId, (doc) => appendPendingInDoc(doc, rec.meta.findingKey, rec.meta.itemId, rec.pendingId));
          if (answer === 'invalid_key') {
            deps.onError?.(new MediaError('INVALID_RECORD'));
            return { failed: 'INVALID_RECORD' };
          }
          return 'added';
        } catch (error) {
          if (isMediaError(error) && error.code === 'BLOCKED') return 'blocked';
          if (isMediaError(error) && error.code === 'DOC_BUSY' && attempt < ENTRY_TRIES) {
            await pause(ENTRY_RETRY_MS);
            continue;
          }
          deps.onError?.(error);
          return { failed: isMediaError(error) ? error.code : 'UNKNOWN' };
        }
      }
      return { failed: 'DOC_BUSY' };
    },

    async swap(inspectionId, pendingId, key) {
      try {
        const answer = await deps.withDoc(inspectionId, (doc) => resolvePendingInDoc(doc, pendingId, key));
        return answer === 'missing' ? 'removed' : 'placed';
      } catch (error) {
        if (!(isMediaError(error) && error.code === 'BLOCKED')) deps.onError?.(error);
        return 'later';
      }
    },

    async remove(inspectionId, rec) {
      try {
        await deps.withDoc(inspectionId, (doc) => removePendingInDoc(doc, rec.meta.findingKey, rec.meta.itemId, rec.pendingId));
        return true;
      } catch (error) {
        if (!(isMediaError(error) && error.code === 'BLOCKED')) deps.onError?.(error);
        return false;
      }
    },

    async exists(inspectionId, rec) {
      try {
        return await deps.withDoc(inspectionId, (doc) => hasPendingEntryInDoc(doc, rec.meta.findingKey, rec.meta.itemId, rec.pendingId));
      } catch (error) {
        if (!(isMediaError(error) && error.code === 'BLOCKED')) deps.onError?.(error);
        return false;
      }
    },
  };
}
