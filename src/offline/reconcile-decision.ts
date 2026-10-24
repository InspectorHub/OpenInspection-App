import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { SYNC_LEASE, withLease, type LeaseHandle } from './lease';
import { sameAccount, type Account } from './outbox';
import { DEFAULT_REGISTRY, isLocalId, type CommandRegistry } from './registry';
import { unattributableOutboxRows, unsentData, type UnsentReason } from './unsent';
import type { SessionProbe, VisibleClient, VisibleFailure } from './visible-client';

/**
 * The decision half of reconciliation: given what the server says is still visible to this member, which local
 * inspections may be removed (`purge`), which must be set aside because they hold unsent work (`quarantine`), and which
 * come back (`unquarantine`). It reads, it holds the shared lease while it does, and it returns a plan. IT NEVER
 * WRITES: no inspection table is touched by any outcome, and nothing here deletes, marks or moves data. Carrying the
 * plan out is a separate step that must itself re-check the unsent predicate in the transaction that purges.
 *
 * When in doubt the answer is keep or quarantine, never purge:
 *  - A plan exists only if every batch of the one request series succeeded, the answer was well formed (see
 *    `visible-client.ts`), the server's identity is the device's account, the device was not locked at the start, before
 *    each request and before the plan is returned, and the lease was still ours. Every other outcome is a typed
 *    non-plan, and a non-plan means no change.
 *  - Candidates are this account's server-confirmed packages that are not being purged and have no create still waiting in
 *    the queue. A package of another account, or of nobody, is `unknownOwner` and is never sent or decided. An inspection
 *    created on the device and not yet acknowledged is never sent: the server cannot know it.
 *  - The unsent predicate (`unsent.ts`) is read AFTER the response, and a fingerprint of everything it reads is compared
 *    with one taken BEFORE the request. An inspection whose queue, media, document, marker or package row changed in
 *    between is `deferred`, never purged and never quarantined on stale facts.
 *  - A quarantined inspection that is still missing is never purged, whatever it holds: it stays until a person acts.
 *  - MASS GUARD: when more than half of the candidates and more than five of them are missing, or when EVERY candidate is
 *    missing (even a single one), the answer is more likely wrong than every inspection having been deleted
 *    (wrong company, wrong environment, a server fault that still answers 200). Every would-be purge becomes a quarantine,
 *    `massSuspicious` is set for the interface to say so, and nothing is un-quarantined on such an answer.
 *  - A queued write that names no usable inspection refuses the whole run (`refused`), before the request and again after.
 *
 * Not a purge reason, ever: how old a package is, how long ago it was refreshed, or how long it has been missing.
 */

export const DEFAULT_MAX_CANDIDATES = 5000;
export const DEFAULT_MAX_RUN_MS = 120_000;
/** More than this many missing, and more than `MASS_FRACTION` of the candidates, is a suspicious answer. */
export const MASS_MIN_MISSING = 5;
export const MASS_FRACTION = 0.5;

export interface ReconcileLimits {
  /** Ids sent per run; the rest are deferred to a later run. Ids are taken in id order. */
  maxCandidates?: number;
  /** No request starts and no plan is made after this much time on the injected clock. */
  maxRunMs?: number;
  maxBatch?: number;
  maxRequests?: number;
}

export interface ReconcileDeps {
  db: Db;
  clock: Clock;
  /** The account the device is signed in as. Read at the start and again after the response. */
  account(): Account | null | Promise<Account | null>;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  visible: Pick<VisibleClient, 'check'>;
  session: Pick<SessionProbe, 'check'>;
  limits?: ReconcileLimits;
  leaseTtlMs?: number;
  /** A fresh lease token per acquisition. Tests only. */
  newToken?: () => string;
  registry?: CommandRegistry;
}

export interface ReconcileProof {
  /** Packages sent to the server. */
  candidates: number;
  requests: number;
  visible: number;
  missing: number;
  excluded: { invalidId: number; purging: number; unconfirmed: number; createPending: number; unknownOwner: number };
  /** True when more candidates existed than one run sends. */
  truncated: boolean;
  /** Why each missing, non-quarantined inspection that was classified counts as unsent. */
  unsent: Record<string, UnsentReason[]>;
  /** Missing inspections that the mass guard turned from purge into quarantine. */
  convertedToQuarantine: number;
}

export interface ReconcilePlan {
  kind: 'plan';
  purge: string[];
  quarantine: string[];
  unquarantine: string[];
  /** Nothing to do: listed by the server, or still missing but already quarantined. */
  keep: string[];
  /** Changed since the request began, or beyond this run's bound: decided by a later run. */
  deferred: string[];
  /** Packages of another account or of nobody; never sent, never decided. */
  unknownOwner: string[];
  massSuspicious: boolean;
  proof: ReconcileProof;
}

export type ReconcileFailure = VisibleFailure | 'session' | 'storage';

export type ReconcileResult =
  | ReconcilePlan
  | { kind: 'busy' }
  | { kind: 'locked' }
  | { kind: 'lease_lost' }
  | { kind: 'no_account' }
  | { kind: 'account_mismatch' }
  | { kind: 'unavailable'; reason: 'role' }
  | { kind: 'auth' }
  | { kind: 'halt'; reason: 'upgrade_required' }
  | { kind: 'failed'; reason: ReconcileFailure; retryAfterMs: number | null }
  | { kind: 'invalid'; reason: 'bad_response' | 'bad_ids' | 'session' }
  | { kind: 'refused'; reason: 'null_inspection_id' };

interface PackageRow {
  inspection_id: string;
  tenant_id: string | null;
  user_id: string | null;
  server_confirmed: number;
  purging: number;
  quarantine_source: string | null;
}

interface Candidate {
  id: string;
  quarantined: boolean;
}

interface LocalView {
  candidates: Candidate[];
  deferredBeyondBound: string[];
  unknownOwner: string[];
  excluded: ReconcileProof['excluded'];
}

async function isLockedNow(deps: ReconcileDeps): Promise<boolean> {
  try {
    return (await deps.isLocked()) !== false;
  } catch {
    return true;
  }
}

async function accountNow(deps: ReconcileDeps): Promise<Account | null> {
  try {
    return await deps.account();
  } catch {
    return null;
  }
}

/** The candidates, read in one transaction together with the creates still queued. */
async function readLocal(db: Db, account: Account, registry: CommandRegistry, maxCandidates: number): Promise<LocalView> {
  const createOps = registry.filter((def) => def.createsInspection === true).map((def) => def.op);
  return db.transaction(async (tx) => {
    const rows = await tx.query<PackageRow>('SELECT inspection_id, tenant_id, user_id, server_confirmed, purging, quarantine_source FROM work_package ORDER BY inspection_id');
    const creating = new Set<string>();
    if (createOps.length > 0) {
      const waiting = await tx.query<{ inspection_id: string | null }>(`SELECT DISTINCT inspection_id FROM outbox WHERE op IN (${createOps.map(() => '?').join(', ')})`, createOps);
      for (const row of waiting) if (row.inspection_id !== null) creating.add(row.inspection_id);
    }
    const excluded = { invalidId: 0, purging: 0, unconfirmed: 0, createPending: 0, unknownOwner: 0 };
    const unknownOwner: string[] = [];
    const eligible: Candidate[] = [];
    for (const row of rows) {
      if (!isLocalId(row.inspection_id)) excluded.invalidId += 1;
      else if (!sameAccount(account, row.tenant_id, row.user_id)) {
        excluded.unknownOwner += 1;
        unknownOwner.push(row.inspection_id);
      } else if (Number(row.purging) !== 0) excluded.purging += 1;
      else if (Number(row.server_confirmed) !== 1) excluded.unconfirmed += 1;
      else if (creating.has(row.inspection_id)) excluded.createPending += 1;
      else eligible.push({ id: row.inspection_id, quarantined: row.quarantine_source !== null });
    }
    return {
      candidates: eligible.slice(0, maxCandidates),
      deferredBeyondBound: eligible.slice(maxCandidates).map((c) => c.id),
      unknownOwner,
      excluded,
    };
  });
}

/**
 * A cheap summary, per candidate, of everything the unsent predicate and the package flags read: the queue and the
 * media table by state (count, newest row, attempts), the stored document (rows, newest row, bytes), both sync proof
 * rows, and the package row. It moves when a row is added, removed or changed. One transaction, grouped queries,
 * no id list in any statement.
 */
async function fingerprints(db: Db, ids: ReadonlySet<string>): Promise<Map<string, string>> {
  return db.transaction(async (tx) => {
    const parts = new Map<string, string[]>();
    const add = (id: string | null, label: string): void => {
      if (id === null || !ids.has(id)) return;
      const list = parts.get(id) ?? [];
      list.push(label);
      parts.set(id, list);
    };
    const queue = await tx.query<{ id: string | null; state: string; n: number; hi: number; a: number }>(
      'SELECT inspection_id AS id, state, COUNT(*) AS n, COALESCE(MAX(seq), 0) AS hi, COALESCE(SUM(attempts), 0) AS a FROM outbox GROUP BY inspection_id, state',
    );
    for (const row of queue) add(row.id, `o:${row.state}:${String(row.n)}:${String(row.hi)}:${String(row.a)}`);
    const media = await tx.query<{ id: string | null; state: string; n: number; hi: number; a: number; k: number }>(
      "SELECT inspection_id AS id, state, COUNT(*) AS n, COALESCE(MAX(created_at), 0) AS hi, COALESCE(SUM(attempts), 0) AS a, COALESCE(SUM(LENGTH(COALESCE(uploaded_key, ''))), 0) AS k FROM media GROUP BY inspection_id, state",
    );
    for (const row of media) add(row.id, `m:${row.state}:${String(row.n)}:${String(row.hi)}:${String(row.a)}:${String(row.k)}`);
    const docs = await tx.query<{ doc_name: string; n: number; hi: number; b: number }>('SELECT doc_name, COUNT(*) AS n, COALESCE(MAX(id), 0) AS hi, COALESCE(SUM(LENGTH(data)), 0) AS b FROM ydoc_updates GROUP BY doc_name');
    for (const row of docs) add(row.doc_name.startsWith('results-') ? row.doc_name.slice('results-'.length) : null, `y:${String(row.n)}:${String(row.hi)}:${String(row.b)}`);
    const proofs = await tx.query<{ doc_name: string; updated_at: number; l: number | null }>('SELECT doc_name, updated_at, LENGTH(covered_state) AS l FROM ydoc_sync');
    for (const row of proofs) {
      const isDeleteSet = row.doc_name.startsWith('ds:results-');
      const id = row.doc_name.startsWith('results-') ? row.doc_name.slice('results-'.length) : isDeleteSet ? row.doc_name.slice('ds:results-'.length) : null;
      add(id, `s:${isDeleteSet ? 'ds' : 'sv'}:${String(row.updated_at)}:${String(row.l)}`);
    }
    const packages = await tx.query<{ inspection_id: string; server_confirmed: number; purging: number; quarantine_source: string | null; package_gen: number; tenant_id: string | null; user_id: string | null }>(
      'SELECT inspection_id, server_confirmed, purging, quarantine_source, package_gen, tenant_id, user_id FROM work_package',
    );
    for (const row of packages) add(row.inspection_id, `w:${String(row.server_confirmed)}:${String(row.purging)}:${row.quarantine_source ?? '-'}:${String(row.package_gen)}:${row.tenant_id ?? '-'}:${row.user_id ?? '-'}`);
    const out = new Map<string, string>();
    for (const id of ids) out.set(id, JSON.stringify([...(parts.get(id) ?? [])].sort()));
    return out;
  });
}

export async function decideReconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  if (await isLockedNow(deps)) return { kind: 'locked' };
  const account = await accountNow(deps);
  if (account === null) return { kind: 'no_account' };
  try {
    const leaseOptions = { clock: deps.clock, ...(deps.leaseTtlMs === undefined ? {} : { ttlMs: deps.leaseTtlMs }), ...(deps.newToken === undefined ? {} : { newToken: deps.newToken }) };
    const outcome = await withLease(deps.db, SYNC_LEASE, leaseOptions, (lease) => run(deps, lease, account));
    return outcome.acquired ? outcome.value : { kind: 'busy' };
  } catch {
    return { kind: 'failed', reason: 'storage', retryAfterMs: null };
  }
}

async function run(deps: ReconcileDeps, lease: LeaseHandle, account: Account): Promise<ReconcileResult> {
  const limits = deps.limits ?? {};
  const registry = deps.registry ?? DEFAULT_REGISTRY;
  const deadlineAt = deps.clock.now() + (limits.maxRunMs ?? DEFAULT_MAX_RUN_MS);

  /** True while the device is unlocked and this run still owns the lease. */
  const gate = async (): Promise<boolean> => !(await isLockedNow(deps)) && (await lease.renew().catch(() => false));
  /** Why a closed gate closed. */
  const stopped = async (): Promise<ReconcileResult> => ((await isLockedNow(deps)) ? { kind: 'locked' } : { kind: 'lease_lost' });

  if ((await unattributableOutboxRows(deps.db)) > 0) return { kind: 'refused', reason: 'null_inspection_id' };

  const local = await readLocal(deps.db, account, registry, Math.max(1, limits.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  const ids = local.candidates.map((c) => c.id);
  const proof: ReconcileProof = {
    candidates: ids.length,
    requests: 0,
    visible: 0,
    missing: 0,
    excluded: local.excluded,
    truncated: local.deferredBeyondBound.length > 0,
    unsent: {},
    convertedToQuarantine: 0,
  };

  const finish = async (plan: Omit<ReconcilePlan, 'kind' | 'proof' | 'unknownOwner' | 'deferred'> & { deferred: string[] }): Promise<ReconcileResult> => {
    if (!(await gate())) return stopped();
    return { kind: 'plan', ...plan, deferred: [...plan.deferred, ...local.deferredBeyondBound], unknownOwner: local.unknownOwner, proof };
  };

  if (ids.length === 0) return finish({ purge: [], quarantine: [], unquarantine: [], keep: [], deferred: [], massSuspicious: false });

  const before = await fingerprints(deps.db, new Set(ids));

  if (!(await gate())) return stopped();
  const identity = await deps.session.check({ gate });
  if (identity.kind === 'auth') return { kind: 'auth' };
  if (identity.kind === 'failed') return { kind: 'failed', reason: 'session', retryAfterMs: null };
  if (identity.kind === 'invalid') return { kind: 'invalid', reason: 'session' };
  if (identity.tenantId !== account.tenantId || identity.userId !== account.userId) return { kind: 'account_mismatch' };

  const answer = await deps.visible.check(ids, {
    gate,
    clock: deps.clock,
    deadlineAt,
    ...(limits.maxBatch === undefined ? {} : { maxBatch: limits.maxBatch }),
    ...(limits.maxRequests === undefined ? {} : { maxRequests: limits.maxRequests }),
  });
  switch (answer.kind) {
    case 'ok':
      break;
    case 'blocked':
      return stopped();
    case 'unavailable':
      return { kind: 'unavailable', reason: 'role' };
    case 'auth':
      return { kind: 'auth' };
    case 'halt':
      return { kind: 'halt', reason: 'upgrade_required' };
    case 'failed':
      return { kind: 'failed', reason: answer.reason, retryAfterMs: answer.retryAfterMs };
    case 'invalid':
      return { kind: 'invalid', reason: answer.reason };
  }
  proof.requests = answer.requests;
  proof.visible = answer.visible.size;

  // The world may have moved while the request was in flight. The lock and the lease are asked once more before the
  // plan is returned; here the account and the queue are.
  const again = await accountNow(deps);
  if (again === null) return { kind: 'no_account' };
  if (!sameAccount(account, again.tenantId, again.userId)) return { kind: 'account_mismatch' };
  if ((await unattributableOutboxRows(deps.db)) > 0) return { kind: 'refused', reason: 'null_inspection_id' };

  const missing = local.candidates.filter((c) => !answer.visible.has(c.id));
  const total = local.candidates.length;
  proof.missing = missing.length;
  const massSuspicious = (missing.length > MASS_MIN_MISSING && missing.length > total * MASS_FRACTION) || missing.length === total;

  // The predicate is read now, after the answer, for the inspections that need it.
  const unsent = new Map<string, UnsentReason[]>();
  for (const candidate of missing) {
    if (candidate.quarantined) continue;
    if (deps.clock.now() > deadlineAt) return { kind: 'failed', reason: 'time_budget', retryAfterMs: null };
    const result = await unsentData(deps.db, candidate.id, account);
    if (result.unknown) return { kind: 'refused', reason: 'null_inspection_id' };
    if (result.unsent) {
      unsent.set(candidate.id, result.reasons);
      proof.unsent[candidate.id] = result.reasons;
    }
  }

  const after = await fingerprints(deps.db, new Set(ids));
  const changed = (id: string): boolean => before.get(id) !== after.get(id);

  const plan = { purge: [] as string[], quarantine: [] as string[], unquarantine: [] as string[], keep: [] as string[], deferred: [] as string[] };
  for (const candidate of local.candidates) {
    const { id } = candidate;
    if (answer.visible.has(id)) {
      if (!candidate.quarantined) plan.keep.push(id);
      else if (massSuspicious) plan.keep.push(id);
      else if (changed(id)) plan.deferred.push(id);
      else plan.unquarantine.push(id);
    } else if (candidate.quarantined) {
      plan.keep.push(id);
    } else if (changed(id)) {
      plan.deferred.push(id);
    } else if (unsent.has(id)) {
      plan.quarantine.push(id);
    } else if (massSuspicious) {
      plan.quarantine.push(id);
      proof.convertedToQuarantine += 1;
    } else {
      plan.purge.push(id);
    }
  }
  return finish({ ...plan, massSuspicious });
}
