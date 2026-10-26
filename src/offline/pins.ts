import type { Db } from '../platform/db';
import { assertAccount, type Account } from './outbox';
import { isLocalId } from './registry';

/**
 * Pins or unpins one package. A pinned inspection stays in the download window and gets its full-size photos.
 *
 * Only this account's package, confirmed by the server, not being purged and not quarantined can be pinned: a pin
 * on any other row would either be meaningless (nothing refreshes it) or look like a promise the device cannot keep.
 * One conditional UPDATE decides, so a package that was quarantined a moment ago cannot slip through a stale read.
 * Unpinning is allowed for any package of this account that is not being purged, confirmed or not, quarantined or not.
 * Resolves false, changing nothing, for every row that does not qualify and for an id that could not be an inspection id.
 */
export async function setPinned(db: Db, account: Account, inspectionId: string, pinned: boolean): Promise<boolean> {
  if (!isLocalId(inspectionId)) return false;
  assertAccount(account);
  // A pin can always be taken back: unpinning needs only that the package is this account's and is not being purged. Pinning
  // keeps the stricter rule above.
  const result = pinned
    ? await db.run(
        'UPDATE work_package SET pinned = 1 WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND server_confirmed = 1 AND purging = 0 AND quarantine_source IS NULL',
        [inspectionId, account.tenantId, account.userId],
      )
    : await db.run('UPDATE work_package SET pinned = 0 WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND purging = 0', [inspectionId, account.tenantId, account.userId]);
  return result.changes === 1;
}
