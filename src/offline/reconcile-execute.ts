import type { NativeCollabConnector } from '../collab/connector';
import type { Clock } from '../platform/clock';
import { SYNC_LEASE, withLease, type LeaseHandle } from './lease';
import { sameAccount, type Account } from './outbox';
import { isIssuedPlan } from './plan-brand';
import { purgeInspection, type PurgeDeps } from './purge';
import { quarantineInspection, unquarantineInspection, type QuarantineOutcome, type UnquarantineOutcome } from './quarantine';
import { DEFAULT_PLAN_MAX_AGE_MS, fingerprintOf, MASS_FRACTION, MASS_MIN_MISSING, planIsStale, REASON_NOT_VISIBLE, type ReconcilePlan } from './reconcile-decision';
import { isLocalId } from './registry';

/**
 * The executing half of reconciliation: carries out the plan `decideReconcile` made, and nothing more.
 *
 * Nothing is trusted from the plan except WHICH inspections it names and WHAT it wants done to each, and every one of those
 * is checked again, closer to the data:
 *  - the plan is for the account that is signed in NOW, is not stale (`planIsStale`), the device is not locked (a lock that
 *    arrives mid-run stops the run before the next inspection, and inside a purge at its next step) and the shared lease
 *    (replay, refresh, reconcile) is ours, renewed before every inspection;
 *  - the fingerprint of the local facts is recomputed per inspection and must equal the one the plan was made on, otherwise
 *    the inspection is SKIPPED (counted, decided by a later run, never acted on stale facts); the purge, the quarantine
 *    and the un-quarantine check it once more inside the transaction that writes (see `purge.ts`, `quarantine.ts`);
 *  - a purge re-runs the owner, acknowledgement, create-queue and unsent-predicate checks inside the tombstone transaction.
 *    A purge that finds unsent data there becomes a quarantine (the safe direction);
 *  - a plan never grows: a purge or an un-quarantine in a plan that says the answer was suspicious or listed nothing, a mass of
 *    purges, a purge whose reasons are anything but "not visible, nothing unsent", an id named for two things and an id that is
 *    not an inspection id are not acted on. The reasons are for audit and can only narrow, never widen.
 *
 * Order within a run: quarantines first (they delete nothing), then un-quarantines, then purges, so a run cut short by a
 * lock has done the safe things first. The result is a typed summary of fixed codes; a failure of one inspection is counted
 * and the next one is still done. Nothing here throws for a per-id failure.
 */

export interface ExecuteDeps extends Omit<PurgeDeps, 'connector' | 'checkpoint'> {
  /** `purge` for removals, `closeFor` for the quarantine. */
  connector: Pick<NativeCollabConnector, 'purge' | 'closeFor'>;
  clock: Clock;
  /** The signed-in account, read now and before every inspection. */
  account(): Account | null | Promise<Account | null>;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  /** Tells the editor an inspection was quarantined (it unmounts it). A throw is ignored. */
  onQuarantined?: (inspectionId: string) => void | Promise<void>;
  /** Tells the flows that were skipping an inspection that it is free again. A throw is ignored. */
  onUnquarantined?: (inspectionId: string) => void | Promise<void>;
  /** A plan older than this is not carried out. Default `DEFAULT_PLAN_MAX_AGE_MS`. */
  maxPlanAgeMs?: number;
  leaseTtlMs?: number;
  /** A fresh lease token per acquisition. Tests only. */
  newToken?: () => string;
}

export interface ExecuteSummary {
  purged: number;
  quarantined: number;
  unquarantined: number;
  /** Purges put off because the editor has the inspection open. */
  deferred: number;
  /** Inspections whose local facts changed since the plan; a later run decides them again. */
  skippedChanged: number;
  /** Everything that did not go as planned and is not a plain skip. */
  failed: number;
  /** Fixed codes with how often each happened (a failure code or a refusal reason; never text from a row, a path or an error). */
  failures: Record<string, number>;
}

export type ExecuteStop = 'plan_not_issued' | 'stale_plan' | 'no_account' | 'account_mismatch' | 'locked' | 'busy' | 'lease_lost';

export type ExecuteResult = { kind: 'done'; summary: ExecuteSummary } | { kind: 'stopped'; reason: ExecuteStop; summary: ExecuteSummary };

type Role = 'quarantine' | 'unquarantine' | 'purge';

interface Task {
  id: string;
  role: Role;
}

function emptySummary(): ExecuteSummary {
  return { purged: 0, quarantined: 0, unquarantined: 0, deferred: 0, skippedChanged: 0, failed: 0, failures: {} };
}

function fail(summary: ExecuteSummary, code: string): void {
  summary.failed += 1;
  summary.failures[code] = (summary.failures[code] ?? 0) + 1;
}

/** More purges than a deletion could plausibly be: the same rule the decision used for "mass suspicious". */
function isMass(plan: ReconcilePlan): boolean {
  const n = plan.purge.length;
  return (n > MASS_MIN_MISSING && n > plan.candidateCount * MASS_FRACTION) || (plan.candidateCount > 0 && n >= plan.candidateCount);
}

/** What the plan asks for, minus everything that is contradictory, malformed or wider than the decision could have meant. */
function tasksOf(plan: ReconcilePlan, summary: ExecuteSummary): Task[] {
  const roles = new Map<string, Role[]>();
  const add = (ids: readonly string[], role: Role): void => {
    for (const id of ids) roles.set(id, [...(roles.get(id) ?? []), role]);
  };
  add(plan.quarantine, 'quarantine');
  add(plan.unquarantine, 'unquarantine');
  add(plan.purge, 'purge');
  const suspicious = plan.massSuspicious || plan.allMissing;
  const mass = isMass(plan);
  const tasks: Task[] = [];
  for (const [id, list] of roles) {
    const first = list[0];
    if (first === undefined) continue;
    if (!isLocalId(id)) {
      fail(summary, 'invalid_id');
      continue;
    }
    if (list.length > 1) {
      fail(summary, 'contradictory_plan');
      continue;
    }
    if (first === 'quarantine') {
      tasks.push({ id, role: first });
      continue;
    }
    if (suspicious) {
      fail(summary, 'incoherent_plan');
      continue;
    }
    if (first === 'purge') {
      const reasons = plan.reasons[id];
      if (mass || reasons === undefined || reasons.length !== 1 || reasons[0] !== REASON_NOT_VISIBLE) {
        fail(summary, 'incoherent_plan');
        continue;
      }
    }
    tasks.push({ id, role: first });
  }
  const rank: Record<Role, number> = { quarantine: 0, unquarantine: 1, purge: 2 };
  return tasks.sort((a, b) => rank[a.role] - rank[b.role] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function noteQuarantine(summary: ExecuteSummary, outcome: QuarantineOutcome): void {
  if (outcome.kind === 'quarantined') summary.quarantined += 1;
  else if (outcome.kind === 'refused') {
    if (outcome.reason === 'changed') summary.skippedChanged += 1;
    else fail(summary, outcome.reason);
  } else if (outcome.kind === 'failed') {
    // The quarantine itself is in place when only the connection could not be closed or the guard did not agree.
    if (outcome.code !== 'storage_failed') summary.quarantined += 1;
    fail(summary, outcome.code);
  }
}

function noteUnquarantine(summary: ExecuteSummary, outcome: UnquarantineOutcome): void {
  if (outcome.kind === 'unquarantined') summary.unquarantined += 1;
  else if (outcome.kind === 'refused') {
    if (outcome.reason === 'changed') summary.skippedChanged += 1;
    else fail(summary, outcome.reason);
  } else if (outcome.kind === 'failed') fail(summary, outcome.code);
}

export async function executeReconcilePlan(deps: ExecuteDeps, plan: ReconcilePlan): Promise<ExecuteResult> {
  const summary = emptySummary();
  const stopped = (reason: ExecuteStop): ExecuteResult => ({ kind: 'stopped', reason, summary });

  const locked = async (): Promise<boolean> => {
    try {
      return (await deps.isLocked()) !== false;
    } catch {
      return true;
    }
  };
  const accountNow = async (): Promise<Account | null> => {
    try {
      return await deps.account();
    } catch {
      return null;
    }
  };
  /** Why the run may not go on, or null when it may. */
  const closed = async (lease: LeaseHandle | null): Promise<ExecuteStop | null> => {
    if (await locked()) return 'locked';
    const who = await accountNow();
    if (who === null) return 'no_account';
    if (!sameAccount(plan.account, who.tenantId, who.userId)) return 'account_mismatch';
    if (lease !== null && !(await lease.renew().catch(() => false))) return 'lease_lost';
    return null;
  };

  // Only the object `decideReconcile` returned: a copy, a clone or a hand-built plan with the right fingerprints is not one.
  if (!isIssuedPlan(plan)) return stopped('plan_not_issued');
  if (planIsStale(plan, deps.clock.now(), deps.maxPlanAgeMs ?? DEFAULT_PLAN_MAX_AGE_MS)) return stopped('stale_plan');
  const first = await closed(null);
  if (first !== null) return stopped(first);

  const leaseOptions = { clock: deps.clock, ...(deps.leaseTtlMs === undefined ? {} : { ttlMs: deps.leaseTtlMs }), ...(deps.newToken === undefined ? {} : { newToken: deps.newToken }) };
  let reason: ExecuteStop | null = null;
  let outcome;
  try {
    outcome = await withLease(deps.db, SYNC_LEASE, leaseOptions, async (lease) => {
      const tasks = tasksOf(plan, summary);
      const quarantineDeps = { db: deps.db, connector: deps.connector, isBlocked: deps.isBlocked, ...(deps.uploader === undefined ? {} : { uploader: deps.uploader }), ...(deps.onQuarantined === undefined ? {} : { onQuarantined: deps.onQuarantined }), ...(deps.onUnquarantined === undefined ? {} : { onUnquarantined: deps.onUnquarantined }) };
      /** The checkpoint a purge asks between its steps: false stops it, tombstone kept, for `resumePurges`. */
      let why: ExecuteStop | null = null;
      const checkpoint = async (): Promise<boolean> => {
        why = await closed(lease);
        return why === null;
      };
      for (const task of tasks) {
        const stop = await closed(lease);
        if (stop !== null) {
          reason = stop;
          return;
        }
        try {
          const expected = plan.fingerprints[task.id];
          if (expected === undefined || expected !== (await fingerprintOf(deps.db, task.id))) {
            summary.skippedChanged += 1;
            continue;
          }
          const options = { account: plan.account, expectedFingerprint: expected };
          if (task.role === 'quarantine') {
            noteQuarantine(summary, await quarantineInspection(quarantineDeps, task.id, options));
          } else if (task.role === 'unquarantine') {
            noteUnquarantine(summary, await unquarantineInspection(quarantineDeps, task.id, options));
          } else {
            const purged = await purgeInspection({ ...deps, checkpoint }, task.id, { mode: 'auto', account: plan.account, expectedFingerprint: expected });
            if (purged.kind === 'purged') summary.purged += 1;
            else if (purged.kind === 'deferred') summary.deferred += 1;
            else if (purged.kind === 'unsent_now') noteQuarantine(summary, await quarantineInspection(quarantineDeps, task.id, { account: plan.account, expectedFingerprint: null }));
            else if (purged.kind === 'refused') {
              if (purged.reason === 'changed') summary.skippedChanged += 1;
              else fail(summary, purged.reason);
            } else if (purged.code === 'interrupted') {
              reason = why ?? 'locked';
              return;
            } else fail(summary, purged.code);
          }
        } catch {
          fail(summary, 'storage_failed');
        }
      }
    });
  } catch {
    fail(summary, 'storage_failed');
    return { kind: 'done', summary };
  }
  if (!outcome.acquired) return stopped('busy');
  return reason === null ? { kind: 'done', summary } : stopped(reason);
}
