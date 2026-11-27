import type { Db } from '../platform/db';
import { assertAccount, type Account } from './outbox';
import { isLocalId } from './registry';

/**
 * Why a pin (or unpin) was refused. `not_found` also covers another account's package: from this account's side the
 * two are indistinguishable, and the distinction must not leak.
 */
export type PinRefusalReason = 'not_confirmed' | 'purging' | 'quarantined' | 'not_found' | 'not_an_inspection';

export type SetPinnedResult = { ok: true } | { ok: false; reason: PinRefusalReason };

/**
 * Pins or unpins one package. A pinned inspection stays in the download window and gets its full-size photos.
 *
 * Only this account's package, confirmed by the server, not being purged and not quarantined can be pinned: a pin
 * on any other row would either be meaningless (nothing refreshes it) or look like a promise the device cannot keep.
 * One conditional UPDATE decides, so a package that was quarantined a moment ago cannot slip through a stale read.
 * Unpinning is allowed for any package of this account that is not being purged, confirmed or not, quarantined or not.
 * Resolves `{ ok: true }` when the package ends pinned (or unpinned) as asked — including when it already was — and
 * `{ ok: false, reason }` naming why not, changing nothing, for every row that does not qualify and for an id that
 * could not be an inspection id.
 */
export async function setPinned(db: Db, account: Account, inspectionId: string, pinned: boolean): Promise<SetPinnedResult> {
  if (!isLocalId(inspectionId)) return { ok: false, reason: 'not_an_inspection' };
  assertAccount(account);
  // A pin can always be taken back: unpinning needs only that the package is this account's and is not being purged. Pinning
  // keeps the stricter rule above.
  const result = pinned
    ? await db.run(
        'UPDATE work_package SET pinned = 1 WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND server_confirmed = 1 AND purging = 0 AND quarantine_source IS NULL',
        [inspectionId, account.tenantId, account.userId],
      )
    : await db.run('UPDATE work_package SET pinned = 0 WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND purging = 0', [inspectionId, account.tenantId, account.userId]);
  if (result.changes === 1) return { ok: true };
  // The UPDATE changed nothing: either the row already had the requested value, or the row does not qualify. Read it
  // (scoped to this account, so another account's package reads as missing) to say which.
  const rows = await db.query<{ pinned: number; server_confirmed: number; purging: number; quarantine_source: string | null }>(
    'SELECT pinned, server_confirmed, purging, quarantine_source FROM work_package WHERE inspection_id = ? AND tenant_id = ? AND user_id = ?',
    [inspectionId, account.tenantId, account.userId],
  );
  const row = rows[0];
  if (row === undefined) return { ok: false, reason: 'not_found' };
  if (Number(row.pinned) === (pinned ? 1 : 0)) return { ok: true };
  if (Number(row.purging) !== 0) return { ok: false, reason: 'purging' };
  if (row.quarantine_source !== null) return { ok: false, reason: 'quarantined' };
  if (pinned && Number(row.server_confirmed) !== 1) return { ok: false, reason: 'not_confirmed' };
  // Unreachable unless the row changed between the UPDATE and the read above; report it as missing rather than guessing.
  return { ok: false, reason: 'not_found' };
}
