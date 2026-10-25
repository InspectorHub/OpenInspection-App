import type { Db } from '../platform/db';
import { assertAccount, type Account } from './outbox';
import { isLocalId } from './registry';

/**
 * Pins or unpins one package. A pinned inspection stays in the download window and gets its full-size photos.
 *
 * Only this account's package, confirmed by the server, not being purged and not quarantined can be pinned: a pin
 * on any other row would either be meaningless (nothing refreshes it) or look like a promise the device cannot keep.
 * One conditional UPDATE decides, so a package that was quarantined a moment ago cannot slip through a stale read.
 * Resolves false, changing nothing, for every row that does not qualify and for an id that could not be an inspection id.
 */
export async function setPinned(db: Db, account: Account, inspectionId: string, pinned: boolean): Promise<boolean> {
  if (!isLocalId(inspectionId)) return false;
  assertAccount(account);
  const result = await db.run(
    'UPDATE work_package SET pinned = ? WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND server_confirmed = 1 AND purging = 0 AND quarantine_source IS NULL',
    [pinned ? 1 : 0, inspectionId, account.tenantId, account.userId],
  );
  return result.changes === 1;
}
