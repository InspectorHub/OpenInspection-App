import { resultsDocName, type NativeCollabConnector } from '../collab/connector';
import { clearSyncProof } from '../collab/sync-proof';
import { deleteDocRows } from '../collab/y-sqlite';
import type { NativeUploader } from '../media/native-uploader';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { isNotFoundError, type Files } from '../platform/files';
import type { IsBlocked } from './blocked';
import { SYNC_LEASE, withLease } from './lease';
import { accountKey, assertAccount, sameAccount, type Account } from './outbox';
import { fingerprintOf } from './reconcile-decision';
import { DEFAULT_REGISTRY, isLocalId, type CommandRegistry } from './registry';
import { unsentData, type UnsentReason } from './unsent';

/**
 * Removes ONE inspection from the device, completely and in an order that survives a crash at any point.
 *
 * The tombstone. `work_package.purging` is the data-layer block (`blocked.ts`): from the moment it is set, the connector,
 * the uploader, the media reconciler, the replayer, the package refresher, the photo store and the queue all refuse the
 * id. It is set together with the final re-check of everything the decision engine looked at, in ONE short transaction,
 * so nothing can slip in between "was it safe?" and "now nothing may touch it". Its value says who decided:
 *  - `TOMBSTONE_AUTO` (1): the reconcile found the inspection gone from the server and, a moment ago, nothing unsent.
 *    A queued write or a photo row that exists later is therefore a surprise, and the purge STOPS instead of deleting it.
 *  - `TOMBSTONE_USER` (2): a person confirmed removing it, queued writes and photos included.
 *
 * The order (each step is idempotent, each database step is one short transaction or one statement):
 *  1. tombstone (above); then the guard other modules use is asked once, and a guard that does not report the tombstone
 *     stops everything (the wiring would not protect the data);
 *  2. the editor is told (`onPurging`), so it unmounts;
 *  3. `connector.purge`: closes the socket, waits for the writes in flight, deletes the document rows and the sync proof
 *     in one transaction;
 *  4. in-flight uploads are cancelled (`uploader.cancelFor`), then each media FILE is removed and only then its ROW. A
 *     file that is already gone counts as removed; any other failure stops the purge here, with the tombstone, and the
 *     next run continues. The file named by a row is touched only when it is exactly `media/<that row's id>.<ext>`;
 *  5. the cached resources of the package, by account and package id, the error marker included;
 *  6. the queued writes (user-confirmed only; an automatic purge asserts there are none);
 *  7. in one transaction: re-check no photo row and no queued write appeared, sweep any document row or proof a late
 *     writer left, and delete the package row LAST.
 *
 * A crash or failure after step N leaves the tombstone and the work of the first N steps done; `resumePurges` (or any
 * later call with `mode: 'resume'`) finishes it, without asking the unsent predicate again because the decision was
 * already taken. No step reads or writes anything of another inspection: every statement names this id (and this
 * account for the cache and the queue).
 */

export const TOMBSTONE_AUTO = 1;
export const TOMBSTONE_USER = 2;
/** How many times the media rows are listed again after a pass deleted some, in case a photo was stored meanwhile. */
const MAX_MEDIA_PASSES = 5;
/** The only file name a media row may point the purge at: its own id and one of the store's extensions. */
const MEDIA_PATH = /^media\/([A-Za-z0-9_-]{1,64})\.(?:jpg|png|heic|mp4|mov)$/;

export type PurgeMode = 'auto' | 'user_confirmed' | 'resume';

export type PurgeOptions =
  | { mode: 'auto'; account: Account; expectedFingerprint: string }
  | { mode: 'user_confirmed'; account: Account }
  | { mode: 'resume'; account: Account };

export type PurgeStep = 'tombstone' | 'editor' | 'connector' | 'files' | 'media_rows' | 'cache' | 'outbox' | 'package';

export type PurgeFailure =
  | 'storage_failed'
  | 'file_remove_failed'
  | 'guard_not_effective'
  /** An automatic tombstone found a queued write or a photo row: not the decision that was taken, so nothing more is deleted. */
  | 'unexpected_data'
  /** The queue holds a write of ANOTHER account for this inspection id; it is not this person's to delete. */
  | 'foreign_outbox'
  | 'media_churn'
  | 'interrupted';

export type PurgeRefusal = 'invalid_id' | 'no_package' | 'not_owner' | 'unconfirmed' | 'create_pending' | 'quarantined' | 'tombstoned' | 'not_tombstoned' | 'unattributable' | 'changed';

export type PurgeOutcome =
  | { kind: 'purged' }
  | { kind: 'deferred'; reason: 'open_in_editor' }
  | { kind: 'unsent_now'; reasons: UnsentReason[] }
  | { kind: 'refused'; reason: PurgeRefusal }
  | { kind: 'failed'; step: PurgeStep; code: PurgeFailure };

export interface PurgeDeps {
  db: Db;
  files: Pick<Files, 'remove' | 'exists'>;
  /** `purge` closes the connection and deletes the document rows and proof of one inspection. */
  connector: Pick<NativeCollabConnector, 'purge'>;
  /** Cancels the uploads of one inspection in flight. Absent or failing is tolerated: the block already refuses new work. */
  uploader?: Pick<NativeUploader, 'cancelFor'>;
  /** The guard every other module is given (`createBlockedGuard`). REQUIRED: the purge verifies it reports its own tombstone. */
  isBlocked: IsBlocked;
  /** True while the editor has this inspection open. An answer that cannot be given counts as open. */
  isOpenInEditor(inspectionId: string): boolean | Promise<boolean>;
  /** Tells the editor to unmount the inspection. A throw is ignored. */
  onPurging(inspectionId: string): void | Promise<void>;
  /** Asked between steps and between files: false (or a throw) stops the purge with `interrupted`, tombstone kept. */
  checkpoint?: () => boolean | Promise<boolean>;
  registry?: CommandRegistry;
}

interface PackageFlags {
  tenant_id: string | null;
  user_id: string | null;
  server_confirmed: number;
  purging: number;
  quarantine_source: string | null;
}

type Phase = { kind: 'go'; tombstone: number } | PurgeOutcome;

const refused = (reason: PurgeRefusal): PurgeOutcome => ({ kind: 'refused', reason });
const failed = (step: PurgeStep, code: PurgeFailure): PurgeOutcome => ({ kind: 'failed', step, code });

async function count(db: Db, sql: string, params: unknown[]): Promise<number> {
  const rows = await db.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** One media file: true when it is gone afterwards. A missing file is gone; a failure with the file still there (or unknowable) is not. */
async function removeFile(files: PurgeDeps['files'], path: string): Promise<boolean> {
  try {
    await files.remove(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return true;
    try {
      return !(await files.exists(path));
    } catch {
      return false;
    }
  }
}

/**
 * Re-reads everything the decision engine looked at and sets the tombstone, in one transaction. Automatic: the owner, the
 * server's acknowledgement, no quarantine, no create still queued, the same fingerprint as the plan and an unsent
 * predicate that is false. User-confirmed: the owner, the acknowledgement and no create still queued. Resume: the owner
 * and a tombstone; an automatic one must still have no queued write and no photo row.
 */
async function tombstone(deps: PurgeDeps, id: string, options: PurgeOptions): Promise<Phase> {
  const { account } = options;
  const createOps = (deps.registry ?? DEFAULT_REGISTRY).filter((def) => def.createsInspection === true).map((def) => def.op);
  return deps.db.transaction(async (tx): Promise<Phase> => {
    const rows = await tx.query<PackageFlags>('SELECT tenant_id, user_id, server_confirmed, purging, quarantine_source FROM work_package WHERE inspection_id = ?', [id]);
    const row = rows[0];
    if (row === undefined) return refused('no_package');
    if (!sameAccount(account, row.tenant_id, row.user_id)) return refused('not_owner');
    const flag = Number(row.purging);
    if (options.mode === 'resume') {
      if (flag !== TOMBSTONE_AUTO && flag !== TOMBSTONE_USER) return refused('not_tombstoned');
      if (flag === TOMBSTONE_AUTO && ((await count(tx, 'SELECT COUNT(*) AS n FROM outbox WHERE inspection_id = ?', [id])) > 0 || (await count(tx, 'SELECT COUNT(*) AS n FROM media WHERE inspection_id = ?', [id])) > 0)) {
        return failed('tombstone', 'unexpected_data');
      }
      return { kind: 'go', tombstone: flag };
    }
    if (Number(row.server_confirmed) !== 1) return refused('unconfirmed');
    // A person may take over an automatic tombstone that got stuck; nothing else may touch a row that is being purged.
    if (flag !== 0 && !(options.mode === 'user_confirmed' && flag === TOMBSTONE_AUTO)) return refused('tombstoned');
    if (options.mode === 'auto' && row.quarantine_source !== null) return refused('quarantined');
    if (createOps.length > 0 && (await count(tx, `SELECT COUNT(*) AS n FROM outbox WHERE inspection_id = ? AND op IN (${createOps.map(() => '?').join(', ')})`, [id, ...createOps])) > 0) {
      return refused('create_pending');
    }
    if (options.mode === 'auto') {
      if ((await fingerprintOf(tx, id)) !== options.expectedFingerprint) return refused('changed');
      const unsent = await unsentData(tx, id, account);
      if (unsent.unknown) return refused('unattributable');
      if (unsent.unsent) return { kind: 'unsent_now', reasons: unsent.reasons };
    }
    const value = options.mode === 'auto' ? TOMBSTONE_AUTO : TOMBSTONE_USER;
    const set = await tx.run('UPDATE work_package SET purging = ? WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND purging IN (0, 1)', [value, id, account.tenantId, account.userId]);
    if (set.changes !== 1) return refused('changed');
    return { kind: 'go', tombstone: value };
  });
}

/** Steps 4: the files, then their rows, in passes. Returns an outcome to stop with, or null when no media row is left. */
async function removeMedia(deps: PurgeDeps, id: string, go: () => Promise<boolean>): Promise<PurgeOutcome | null> {
  for (let pass = 0; pass < MAX_MEDIA_PASSES; pass += 1) {
    const rows = await deps.db.query<{ pending_id: string; path: string }>('SELECT pending_id, path FROM media WHERE inspection_id = ? ORDER BY created_at, pending_id', [id]);
    if (rows.length === 0) return null;
    let stuck = false;
    for (const row of rows) {
      if (!(await go())) return failed('files', 'interrupted');
      const match = MEDIA_PATH.exec(row.path);
      // A path that is not this row's own file name is not trusted: only the row goes, no file is touched.
      if (match !== null && match[1] === row.pending_id && !(await removeFile(deps.files, row.path))) {
        stuck = true;
        continue;
      }
      await deps.db.run('DELETE FROM media WHERE pending_id = ? AND inspection_id = ?', [row.pending_id, id]);
    }
    if (stuck) return failed('files', 'file_remove_failed');
  }
  return (await count(deps.db, 'SELECT COUNT(*) AS n FROM media WHERE inspection_id = ?', [id])) === 0 ? null : failed('media_rows', 'media_churn');
}

/** Removes one inspection from the device. Never throws: every failure is a typed outcome. See the module comment. */
export async function purgeInspection(deps: PurgeDeps, inspectionId: string, options: PurgeOptions): Promise<PurgeOutcome> {
  if (!isLocalId(inspectionId)) return refused('invalid_id');
  try {
    assertAccount(options.account);
  } catch {
    return refused('not_owner');
  }
  const { account } = options;
  const go = async (): Promise<boolean> => {
    if (deps.checkpoint === undefined) return true;
    try {
      return (await deps.checkpoint()) !== false;
    } catch {
      return false;
    }
  };
  let step: PurgeStep = 'tombstone';
  try {
    if (options.mode === 'auto') {
      let open: boolean;
      try {
        open = (await deps.isOpenInEditor(inspectionId)) !== false;
      } catch {
        open = true;
      }
      if (open) return { kind: 'deferred', reason: 'open_in_editor' };
    }

    const phase = await tombstone(deps, inspectionId, options);
    if (phase.kind !== 'go') return phase;
    const mark = phase.tombstone;

    // The tombstone only protects the data if the guard the other modules use says so.
    let effective: boolean;
    try {
      effective = (await deps.isBlocked(inspectionId)) === true;
    } catch {
      effective = false;
    }
    if (!effective) return failed('tombstone', 'guard_not_effective');

    step = 'editor';
    try {
      await deps.onPurging(inspectionId);
    } catch {
      // The block is in the data; a failing signal only leaves the editor to find out by itself.
    }
    if (!(await go())) return failed('editor', 'interrupted');

    step = 'connector';
    await deps.connector.purge(inspectionId);
    if (!(await go())) return failed('connector', 'interrupted');

    step = 'files';
    try {
      await deps.uploader?.cancelFor(inspectionId);
    } catch {
      // Whatever could not be cancelled finds its row gone, or is refused at its next block check.
    }
    const media = await removeMedia(deps, inspectionId, go);
    if (media !== null) return media;

    step = 'cache';
    if (!(await go())) return failed('cache', 'interrupted');
    await deps.db.run('DELETE FROM resource_cache WHERE account_key = ? AND package_id = ?', [accountKey(account), inspectionId]);

    step = 'outbox';
    if (!(await go())) return failed('outbox', 'interrupted');
    if (mark === TOMBSTONE_USER) await deps.db.run('DELETE FROM outbox WHERE inspection_id = ? AND tenant_id = ? AND user_id = ?', [inspectionId, account.tenantId, account.userId]);
    if ((await count(deps.db, 'SELECT COUNT(*) AS n FROM outbox WHERE inspection_id = ?', [inspectionId])) > 0) {
      return failed('outbox', mark === TOMBSTONE_USER ? 'foreign_outbox' : 'unexpected_data');
    }

    step = 'package';
    if (!(await go())) return failed('package', 'interrupted');
    const docName = resultsDocName(inspectionId);
    const last = await deps.db.transaction(async (tx): Promise<PurgeOutcome> => {
      const rows = await tx.query<PackageFlags>('SELECT tenant_id, user_id, server_confirmed, purging, quarantine_source FROM work_package WHERE inspection_id = ?', [inspectionId]);
      const row = rows[0];
      if (row === undefined) return { kind: 'purged' };
      if (!sameAccount(account, row.tenant_id, row.user_id) || (Number(row.purging) !== TOMBSTONE_AUTO && Number(row.purging) !== TOMBSTONE_USER)) return refused('changed');
      if ((await count(tx, 'SELECT COUNT(*) AS n FROM media WHERE inspection_id = ?', [inspectionId])) > 0) return failed('media_rows', 'media_churn');
      if ((await count(tx, 'SELECT COUNT(*) AS n FROM outbox WHERE inspection_id = ?', [inspectionId])) > 0) return failed('outbox', mark === TOMBSTONE_USER ? 'foreign_outbox' : 'unexpected_data');
      // Anything a late writer left since the earlier steps goes in the same transaction that deletes the package row.
      await deleteDocRows(tx, docName);
      await clearSyncProof(tx, docName);
      await tx.run('DELETE FROM resource_cache WHERE account_key = ? AND package_id = ?', [accountKey(account), inspectionId]);
      await tx.run('DELETE FROM work_package WHERE inspection_id = ? AND tenant_id = ? AND user_id = ? AND purging IN (1, 2)', [inspectionId, account.tenantId, account.userId]);
      return { kind: 'purged' };
    });
    return last;
  } catch {
    return failed(step, 'storage_failed');
  }
}

export interface ResumeDeps extends PurgeDeps {
  clock: Clock;
  /** The signed-in account. Only its own tombstones are resumed. */
  account(): Account | null | Promise<Account | null>;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  leaseTtlMs?: number;
  newToken?: () => string;
}

export interface ResumeSummary {
  resumed: number;
  failed: number;
  /** Tombstones of another account or of nobody: left exactly as they are. */
  foreign: number;
  /** Why the run ended before it reached the last tombstone, when it did. */
  stopped: 'locked' | 'no_account' | 'busy' | 'lease_lost' | null;
  /** Fixed codes (a failure code or a refusal reason) with how often each happened. */
  failures: Record<string, number>;
}

/**
 * Finds the tombstones of the signed-in account and drives each to completion, skipping the unsent predicate (the
 * decision was taken). Meant for boot and for the start of a refresh. Does nothing while the device is locked, with no
 * account, or while another flow holds the shared lease; takes the lease itself and checks lock and lease between every
 * step of every purge.
 */
export async function resumePurges(deps: ResumeDeps): Promise<ResumeSummary> {
  const summary: ResumeSummary = { resumed: 0, failed: 0, foreign: 0, stopped: null, failures: {} };
  const locked = async (): Promise<boolean> => {
    try {
      return (await deps.isLocked()) !== false;
    } catch {
      return true;
    }
  };
  if (await locked()) return { ...summary, stopped: 'locked' };
  let account: Account | null;
  try {
    account = await deps.account();
  } catch {
    account = null;
  }
  if (account === null) return { ...summary, stopped: 'no_account' };
  const who = account;
  const leaseOptions = { clock: deps.clock, ...(deps.leaseTtlMs === undefined ? {} : { ttlMs: deps.leaseTtlMs }), ...(deps.newToken === undefined ? {} : { newToken: deps.newToken }) };
  const outcome = await withLease(deps.db, SYNC_LEASE, leaseOptions, async (lease) => {
    const rows = await deps.db.query<{ inspection_id: string; tenant_id: string | null; user_id: string | null }>('SELECT inspection_id, tenant_id, user_id FROM work_package WHERE purging <> 0 ORDER BY inspection_id');
    const own: string[] = [];
    for (const row of rows) {
      if (isLocalId(row.inspection_id) && sameAccount(who, row.tenant_id, row.user_id)) own.push(row.inspection_id);
      else summary.foreign += 1;
    }
    let lost = false;
    const open = async (): Promise<boolean> => {
      if (await locked()) return false;
      if (!(await lease.renew().catch(() => false))) {
        lost = true;
        return false;
      }
      return deps.checkpoint === undefined ? true : (await Promise.resolve(deps.checkpoint()).catch(() => false)) !== false;
    };
    for (const id of own) {
      if (!(await open())) {
        summary.stopped = lost ? 'lease_lost' : 'locked';
        return;
      }
      const result = await purgeInspection({ ...deps, checkpoint: open }, id, { mode: 'resume', account: who });
      if (result.kind === 'purged') {
        summary.resumed += 1;
        continue;
      }
      summary.failed += 1;
      const code = result.kind === 'failed' ? result.code : result.kind === 'refused' ? result.reason : result.kind;
      summary.failures[code] = (summary.failures[code] ?? 0) + 1;
      if (result.kind === 'failed' && result.code === 'interrupted') {
        summary.stopped = lost ? 'lease_lost' : 'locked';
        return;
      }
    }
  });
  if (!outcome.acquired) return { ...summary, stopped: 'busy' };
  return summary;
}
