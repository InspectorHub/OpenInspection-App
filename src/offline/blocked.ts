import type { Db } from '../platform/db';
import { isLocalId } from './registry';

/**
 * The data-layer block. An inspection is blocked while its package row says it is being purged (the tombstone) or is
 * quarantined. A blocked inspection is refused by every module that would touch its data: the collaboration connector
 * (no connection), the media uploader and reconciler (rows are left as they are), the replayer (its queued writes stay
 * pending) and the package refresher. The interface hides the editor too, but nothing relies on that: the check is
 * made where the data is read and written.
 *
 * The row is the only source. Nothing is cached here, so a flag set or cleared in a transaction is seen by the next
 * call, and a check that cannot be answered counts as blocked (`createBlockedGuard`).
 */
export type BlockedState = 'none' | 'quarantined' | 'purging';

/** Answers whether an inspection is blocked. Never rejects. */
export type IsBlocked = (inspectionId: string) => Promise<boolean>;

interface FlagRow {
  purging: number;
  quarantine_source: string | null;
}

/**
 * Reads the block of one inspection. `purging` wins over a quarantine. An inspection with no package row is `none`:
 * nothing is known about it, and a package that was purged to the end is exactly that. A quarantine source this code
 * does not know still counts as quarantined. Throws `RangeError` for an id that could not be an inspection id, and
 * rejects when the read fails; use `createBlockedGuard` for an answer that never rejects.
 */
export async function blockedState(db: Pick<Db, 'query'>, inspectionId: string): Promise<BlockedState> {
  if (!isLocalId(inspectionId)) throw new RangeError('Invalid inspection id');
  const rows = await db.query<FlagRow>('SELECT purging, quarantine_source FROM work_package WHERE inspection_id = ?', [inspectionId]);
  const row = rows[0];
  if (row === undefined) return 'none';
  if (Number(row.purging) !== 0) return 'purging';
  return row.quarantine_source !== null ? 'quarantined' : 'none';
}

/**
 * The guard the modules are given. FAIL CLOSED: an id that is not an inspection id, or a read that throws, is
 * reported as blocked, because "could not check" must never be read as "free to touch".
 */
export function createBlockedGuard(db: Pick<Db, 'query'>): IsBlocked {
  return async (inspectionId) => {
    try {
      return (await blockedState(db, inspectionId)) !== 'none';
    } catch {
      return true;
    }
  };
}
