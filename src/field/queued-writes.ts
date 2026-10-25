import { listOutbox, type Account } from '../offline/outbox';
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
