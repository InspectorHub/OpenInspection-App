import { listOutbox, type Account } from '../offline/outbox';
import { MAX_UPLOAD_ATTEMPTS } from '../media/native-uploader';
import type { MediaStore } from '../media/store';
import type { Db } from '../platform/db';

/**
 * True while this account has a write for this inspection that has not been sent: queued (`pending`) or stopped for a
 * person (`failed`). A later write must not go to the server past it, or it would be applied out of order and the
 * queued one would then overwrite it. When the queue cannot be read the answer is true: "could not check" must never
 * read as "free to send".
 */
export async function hasQueuedWrites(db: Db, account: Account, inspectionId: string): Promise<boolean> {
  try {
    const rows = await listOutbox(db, { account, inspectionId, states: ['pending', 'failed'] });
    return rows.length > 0;
  } catch {
    return true;
  }
}

/** What keeps a report from carrying all of this inspection's photos: nothing, photos that can still arrive, or photos that never will by themselves. */
export type UnsentPhotos = 'none' | 'waiting' | 'stuck';

/**
 * Whether a report published now would silently leave photos or clips out, because the server skips an entry that is still
 * waiting for its upload. This includes defect photos, which have no entry in the document.
 *  - `stuck`: a row that stopped for good (`failed` at the attempt limit). It will not upload by itself, so waiting is no answer.
 *  - `waiting`: a row that is pending, uploading or failed but still retried, and an `uploaded` row that is not attached yet.
 *  - `none`: nothing of that. An `uploaded` row the reconciler's last look found no entry for (`isKnownMissing`) does not count:
 *    it belongs to nothing in the report, and counting it would block every publish until a person removed it in Settings.
 * When the list cannot be read the answer is `waiting`: "could not check" must never read as "nothing is waiting". When both
 * kinds exist the answer is `stuck`, the one a person has to act on.
 */
export async function unsentPhotos(store: Pick<MediaStore, 'listRows'>, inspectionId: string, isKnownMissing: (pendingId: string) => boolean): Promise<UnsentPhotos> {
  try {
    const rows = await store.listRows({ inspectionId, states: ['pending', 'uploading', 'failed', 'uploaded'] });
    let answer: UnsentPhotos = 'none';
    for (const row of rows) {
      if (row.state === 'failed' && row.attempts >= MAX_UPLOAD_ATTEMPTS) return 'stuck';
      if (row.state === 'uploaded' && isKnownMissing(row.pendingId)) continue;
      answer = 'waiting';
    }
    return answer;
  } catch {
    return 'waiting';
  }
}
