import type { NativeCollabConnector } from '../collab/connector';
import type { NativeUploader } from '../media/native-uploader';
import type { Db } from '../platform/db';
import type { IsBlocked } from './blocked';
import { assertAccount, markOrphaned, sameAccount, unorphan, type Account } from './outbox';
import { fingerprintOf } from './reconcile-decision';
import { isLocalId } from './registry';

/**
 * The quarantine: an inspection the server no longer lists but whose device copy holds work nobody sent. NOTHING is
 * deleted. The package row gets the one quarantine source, its pending queued writes are held as `orphaned` (counted on
 * their own line, never sent, never failed, restored by the un-quarantine), and from then on the data-layer block
 * (`blocked.ts`) keeps the connector, the uploader, the replayer, the refresher and the photo store away from it until a
 * person removes it or the server lists it again.
 *
 * The package row and the queue change in ONE transaction that also re-checks the owner, that the package is not being
 * purged and is acknowledged by the server, and (when the caller has one) that the fingerprint of the local facts is the
 * one the plan rested on. Afterwards the guard other modules use is asked once: if it does not report the quarantine the
 * wiring would not protect the data and the outcome says so (the quarantine itself stays, which is the safe direction).
 * Then the live connection is closed, in-flight uploads are cancelled and the editor is told; none of those can undo the
 * quarantine.
 */

export type QuarantineRefusal = 'invalid_id' | 'no_package' | 'not_owner' | 'purging' | 'unconfirmed' | 'changed';

export type QuarantineOutcome =
  | { kind: 'quarantined'; orphaned: number }
  | { kind: 'unchanged' }
  | { kind: 'refused'; reason: QuarantineRefusal }
  | { kind: 'failed'; code: 'storage_failed' | 'guard_not_effective' | 'close_failed' };

export type UnquarantineOutcome =
  | { kind: 'unquarantined'; restored: number }
  | { kind: 'unchanged' }
  | { kind: 'refused'; reason: QuarantineRefusal }
  | { kind: 'failed'; code: 'storage_failed' };

export interface QuarantineDeps {
  db: Db;
  connector: Pick<NativeCollabConnector, 'closeFor'>;
  /** Absent or failing is tolerated: the block already refuses new work. */
  uploader?: Pick<NativeUploader, 'cancelFor'>;
  /** The guard every other module is given (`createBlockedGuard`). REQUIRED: the quarantine verifies it reports itself. */
  isBlocked: IsBlocked;
  /** Tells the editor to unmount the inspection. A throw is ignored. */
  onQuarantined?: (inspectionId: string) => void | Promise<void>;
  /** Tells the flows that were skipping the inspection (media reconciler, replayer) to look again. A throw is ignored. */
  onUnquarantined?: (inspectionId: string) => void | Promise<void>;
}

export interface QuarantineOptions {
  account: Account;
  /** The fingerprint the plan rested on. Omitted when a purge turned into a quarantine because unsent data was found: the safe direction needs no plan. */
  expectedFingerprint?: string;
}

interface Flags {
  tenant_id: string | null;
  user_id: string | null;
  server_confirmed: number;
  purging: number;
  quarantine_source: string | null;
}

const refused = (reason: QuarantineRefusal): { kind: 'refused'; reason: QuarantineRefusal } => ({ kind: 'refused', reason });

function accountUsable(account: Account): boolean {
  try {
    assertAccount(account);
    return true;
  } catch {
    return false;
  }
}

export async function quarantineInspection(deps: QuarantineDeps, inspectionId: string, options: QuarantineOptions): Promise<QuarantineOutcome> {
  if (!isLocalId(inspectionId)) return refused('invalid_id');
  if (!accountUsable(options.account)) return refused('not_owner');
  const { account } = options;
  let result: QuarantineOutcome;
  try {
    result = await deps.db.transaction(async (tx): Promise<QuarantineOutcome> => {
      const rows = await tx.query<Flags>('SELECT tenant_id, user_id, server_confirmed, purging, quarantine_source FROM work_package WHERE inspection_id = ?', [inspectionId]);
      const row = rows[0];
      if (row === undefined) return refused('no_package');
      if (!sameAccount(account, row.tenant_id, row.user_id)) return refused('not_owner');
      if (Number(row.purging) !== 0) return refused('purging');
      if (Number(row.server_confirmed) !== 1) return refused('unconfirmed');
      if (row.quarantine_source !== null) return { kind: 'unchanged' };
      if (options.expectedFingerprint !== undefined && (await fingerprintOf(tx, inspectionId)) !== options.expectedFingerprint) return refused('changed');
      const set = await tx.run("UPDATE work_package SET quarantine_source = 'reconcile_missing' WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND purging = 0 AND quarantine_source IS NULL", [inspectionId, account.tenantId, account.userId]);
      if (set.changes !== 1) return refused('changed');
      const orphaned = await markOrphaned(tx, inspectionId, account);
      return { kind: 'quarantined', orphaned };
    });
  } catch {
    return { kind: 'failed', code: 'storage_failed' };
  }
  if (result.kind !== 'quarantined') return result;

  let effective: boolean;
  try {
    effective = (await deps.isBlocked(inspectionId)) === true;
  } catch {
    effective = false;
  }
  if (!effective) return { kind: 'failed', code: 'guard_not_effective' };

  let closeFailed = false;
  try {
    await deps.connector.closeFor(inspectionId);
  } catch {
    closeFailed = true;
  }
  try {
    await deps.uploader?.cancelFor(inspectionId);
  } catch {
    // Whatever could not be cancelled is refused at its next block check.
  }
  try {
    await deps.onQuarantined?.(inspectionId);
  } catch {
    // The block is in the data; a failing signal only leaves the editor to find out by itself.
  }
  return closeFailed ? { kind: 'failed', code: 'close_failed' } : result;
}

export async function unquarantineInspection(deps: QuarantineDeps, inspectionId: string, options: QuarantineOptions): Promise<UnquarantineOutcome> {
  if (!isLocalId(inspectionId)) return refused('invalid_id');
  if (!accountUsable(options.account)) return refused('not_owner');
  const { account } = options;
  let result: UnquarantineOutcome;
  try {
    result = await deps.db.transaction(async (tx): Promise<UnquarantineOutcome> => {
      const rows = await tx.query<Flags>('SELECT tenant_id, user_id, server_confirmed, purging, quarantine_source FROM work_package WHERE inspection_id = ?', [inspectionId]);
      const row = rows[0];
      if (row === undefined) return refused('no_package');
      if (!sameAccount(account, row.tenant_id, row.user_id)) return refused('not_owner');
      if (Number(row.purging) !== 0) return refused('purging');
      if (row.quarantine_source === null) return { kind: 'unchanged' };
      if (options.expectedFingerprint !== undefined && (await fingerprintOf(tx, inspectionId)) !== options.expectedFingerprint) return refused('changed');
      const cleared = await tx.run('UPDATE work_package SET quarantine_source = NULL WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND purging = 0 AND quarantine_source IS NOT NULL', [inspectionId, account.tenantId, account.userId]);
      if (cleared.changes !== 1) return refused('changed');
      const restored = await unorphan(tx, inspectionId, account);
      return { kind: 'unquarantined', restored };
    });
  } catch {
    return { kind: 'failed', code: 'storage_failed' };
  }
  if (result.kind === 'unquarantined') {
    try {
      await deps.onUnquarantined?.(inspectionId);
    } catch {
      // The flows also look again on their own triggers.
    }
  }
  return result;
}
