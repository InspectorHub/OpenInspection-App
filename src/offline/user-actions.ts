import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { isValidMediaId } from '../media/errors';
import { SYNC_LEASE, withLease } from './lease';
import { sameAccount, type Account } from './outbox';
import { purgeInspection, type PurgeDeps, type PurgeOutcome, type PurgeRefusal } from './purge';
import { planIsStale, REASON_MASS_SUSPICIOUS, type ReconcilePlan } from './reconcile-decision';
import { ALLOWED_GLOBAL_OPS, isLocalId } from './registry';

/**
 * The actions a person takes to leave the states the automatic flows will not leave on their own. This is the API only;
 * the screens that call it come later. Each one needs `confirmed: true` (anything else throws, so a missing confirmation
 * is a bug that cannot go unnoticed), each one is narrow enough that it cannot be used to wipe a healthy inspection or an
 * ordinary queue, and each one reports with fixed codes only: no path, payload text or error message is ever in a result,
 * with the single exception of `discardOutboxRow`, whose whole point is to hand the discarded payload back for export.
 */

export interface UserActionDeps extends PurgeDeps {
  clock: Clock;
  account(): Account | null | Promise<Account | null>;
  leaseTtlMs?: number;
  newToken?: () => string;
}

export type RemoveOutcome = PurgeOutcome | { kind: 'busy' } | { kind: 'refused'; reason: PurgeRefusal | 'no_account' | 'not_quarantined' };

export interface RemoveOptions {
  confirmed: true;
  /**
   * The latest reconcile plan, for an inspection the answer called suspicious (every inspection would have been removed)
   * and that has not been quarantined yet. It must be this account's, not stale, name the id in its quarantine list and
   * give `mass_suspicious` as the reason. Without it only a quarantined inspection (or a purge that stopped on its own) can be removed.
   */
  plan?: ReconcilePlan;
}

function requireConfirmation(options: { confirmed?: unknown } | undefined, what: string): void {
  if (options?.confirmed !== true) throw new Error(`${what} needs an explicit confirmation`);
}

function massEvidence(plan: ReconcilePlan | undefined, id: string, account: Account, now: number): boolean {
  return (
    plan !== undefined &&
    plan.massSuspicious &&
    sameAccount(plan.account, account.tenantId, account.userId) &&
    !planIsStale(plan, now) &&
    plan.quarantine.includes(id) &&
    (plan.reasons[id] ?? []).includes(REASON_MASS_SUSPICIOUS)
  );
}

/**
 * "No longer on the server, remove from this device." A person-confirmed purge: the queued writes and photos of the
 * inspection go too. Only for an inspection that is quarantined, one a suspicious answer named in the latest plan, or one
 * whose purge stopped on its own (tombstone 1 or 2: the person finishes it). Anything else is refused as `not_quarantined`:
 * this is not a way to wipe a healthy inspection. Takes the shared lease (`busy` when another flow holds it).
 */
export async function removeFromDevice(deps: UserActionDeps, inspectionId: string, options: RemoveOptions): Promise<RemoveOutcome> {
  requireConfirmation(options, 'Removing an inspection');
  if (!isLocalId(inspectionId)) return { kind: 'refused', reason: 'invalid_id' };
  let account: Account | null;
  try {
    account = await deps.account();
  } catch {
    account = null;
  }
  if (account === null) return { kind: 'refused', reason: 'no_account' };
  const who = account;
  const leaseOptions = { clock: deps.clock, ...(deps.leaseTtlMs === undefined ? {} : { ttlMs: deps.leaseTtlMs }), ...(deps.newToken === undefined ? {} : { newToken: deps.newToken }) };
  const outcome = await withLease(deps.db, SYNC_LEASE, leaseOptions, async (): Promise<RemoveOutcome> => {
    const rows = await deps.db.query<{ tenant_id: string | null; user_id: string | null; purging: number; quarantine_source: string | null }>('SELECT tenant_id, user_id, purging, quarantine_source FROM work_package WHERE inspection_id = ?', [inspectionId]);
    const row = rows[0];
    if (row === undefined) return { kind: 'refused', reason: 'no_package' };
    if (!sameAccount(who, row.tenant_id, row.user_id)) return { kind: 'refused', reason: 'not_owner' };
    const flag = Number(row.purging);
    if (flag === 0 && row.quarantine_source === null && !massEvidence(options.plan, inspectionId, who, deps.clock.now())) return { kind: 'refused', reason: 'not_quarantined' };
    // A person-confirmed tombstone is finished as it is; an automatic one that got stuck is taken over by this confirmation.
    return purgeInspection(deps, inspectionId, flag === 2 ? { mode: 'resume', account: who } : { mode: 'user_confirmed', account: who });
  });
  return outcome.acquired ? outcome.value : { kind: 'busy' };
}

export type DiscardMediaOutcome =
  | { kind: 'discarded'; inspectionId: string }
  | { kind: 'not_found' }
  | { kind: 'refused'; reason: 'purging' }
  | { kind: 'failed'; code: 'file_remove_failed' | 'storage_failed' };

const MEDIA_PATH = /^media\/([A-Za-z0-9_-]{1,64})\.(?:jpg|png|heic|mp4|mov)$/;

/**
 * Deletes one stuck photo or clip: its file first, then its row. The way out of "any photo row counts as unsent". A file
 * that is already gone is fine; a file that cannot be removed keeps the row. Refused for a photo of an inspection that is
 * being purged (the purge removes it). The file touched is only ever `media/<this row's id>.<ext>`.
 */
export async function discardMedia(deps: Pick<UserActionDeps, 'db' | 'files'>, pendingId: string, options: { confirmed: true }): Promise<DiscardMediaOutcome> {
  requireConfirmation(options, 'Discarding a photo');
  if (!isValidMediaId(pendingId)) return { kind: 'not_found' };
  try {
    const rows = await deps.db.query<{ pending_id: string; inspection_id: string; path: string }>('SELECT pending_id, inspection_id, path FROM media WHERE pending_id = ?', [pendingId]);
    const row = rows[0];
    if (row === undefined) return { kind: 'not_found' };
    const flags = await deps.db.query<{ purging: number }>('SELECT purging FROM work_package WHERE inspection_id = ?', [row.inspection_id]);
    if (flags[0] !== undefined && Number(flags[0].purging) !== 0) return { kind: 'refused', reason: 'purging' };
    const match = MEDIA_PATH.exec(row.path);
    if (match !== null && match[1] === row.pending_id) {
      try {
        await deps.files.remove(row.path);
      } catch {
        const gone = await deps.files.exists(row.path).then(
          (there) => !there,
          () => false,
        );
        if (!gone) return { kind: 'failed', code: 'file_remove_failed' };
      }
    }
    await deps.db.run('DELETE FROM media WHERE pending_id = ?', [pendingId]);
    return { kind: 'discarded', inspectionId: row.inspection_id };
  } catch {
    return { kind: 'failed', code: 'storage_failed' };
  }
}

export interface UnattributableRow {
  idempotencyKey: string;
  seq: number;
  op: string;
  state: string;
  lastError: string | null;
  createdAt: number;
}

interface OutboxLine {
  idempotency_key: string;
  seq: number;
  op: string;
  state: string;
  last_error: string | null;
  created_at: number;
  inspection_id: string | null;
  tenant_id: string | null;
  user_id: string | null;
}

/** The same rule the unsent predicate uses to refuse the whole reconcile. */
function namesNoInspection(row: Pick<OutboxLine, 'inspection_id' | 'op'>): boolean {
  if (row.inspection_id === null && ALLOWED_GLOBAL_OPS.includes(row.op)) return false;
  return !isLocalId(row.inspection_id);
}

function ownedBy(account: Account, row: Pick<OutboxLine, 'tenant_id' | 'user_id'>): boolean {
  return (row.tenant_id === null && row.user_id === null) || sameAccount(account, row.tenant_id, row.user_id);
}

const LIST_LIMIT = 1000;

/**
 * The queued writes that name no usable inspection: each one refuses the whole reconcile until it is gone. Lists this
 * account's rows and those of nobody, without their payloads; rows of another account are only counted (that account
 * must sign in, or the device be cleared, to deal with them).
 */
export async function listUnattributableOutbox(db: Db, account: Account): Promise<{ rows: UnattributableRow[]; foreign: number }> {
  const lines = await db.query<OutboxLine>('SELECT idempotency_key, seq, op, state, last_error, created_at, inspection_id, tenant_id, user_id FROM outbox ORDER BY seq');
  const rows: UnattributableRow[] = [];
  let foreign = 0;
  for (const line of lines) {
    if (!namesNoInspection(line)) continue;
    if (!ownedBy(account, line)) foreign += 1;
    else if (rows.length < LIST_LIMIT) rows.push({ idempotencyKey: line.idempotency_key, seq: line.seq, op: line.op, state: line.state, lastError: line.last_error, createdAt: line.created_at });
  }
  return { rows, foreign };
}

export type DiscardOutboxOutcome =
  | { kind: 'discarded'; idempotencyKey: string; op: string; /** The stored payload text, unparsed, so it can be offered for export. */ payload: string }
  | { kind: 'not_found' }
  | { kind: 'refused'; reason: 'not_unattributable' | 'foreign' | 'no_account' };

/**
 * Deletes one queued write that names no usable inspection and hands back its raw payload text, read in the same
 * transaction that deletes it. Never touches a row that names its inspection (those have their own retry and discard) and
 * never another account's row.
 */
export async function discardOutboxRow(deps: Pick<UserActionDeps, 'db' | 'account'>, idempotencyKey: string, options: { confirmed: true }): Promise<DiscardOutboxOutcome> {
  requireConfirmation(options, 'Discarding a queued write');
  let account: Account | null;
  try {
    account = await deps.account();
  } catch {
    account = null;
  }
  if (account === null) return { kind: 'refused', reason: 'no_account' };
  const who = account;
  return deps.db.transaction(async (tx): Promise<DiscardOutboxOutcome> => {
    const rows = await tx.query<OutboxLine & { payload: string }>('SELECT idempotency_key, seq, op, state, last_error, created_at, inspection_id, tenant_id, user_id, payload FROM outbox WHERE idempotency_key = ?', [idempotencyKey]);
    const row = rows[0];
    if (row === undefined) return { kind: 'not_found' };
    if (!namesNoInspection(row)) return { kind: 'refused', reason: 'not_unattributable' };
    if (!ownedBy(who, row)) return { kind: 'refused', reason: 'foreign' };
    await tx.run('DELETE FROM outbox WHERE idempotency_key = ?', [idempotencyKey]);
    return { kind: 'discarded', idempotencyKey: row.idempotency_key, op: row.op, payload: row.payload };
  });
}
