import { realTimers, type TimerPort } from '../collab/timers';
import type { Clock } from '../platform/clock';
import type { Network } from '../platform/network';
import type { AppStatePort } from './lock-monitor';
import type { ResumeSummary } from './purge';
import type { ReconcilePlan, ReconcileResult } from './reconcile-decision';
import type { ExecuteResult } from './reconcile-execute';

/**
 * The orchestrator of reconciliation: decides WHEN the flow runs, and runs it as one thing under single flight.
 *
 * The flow is: resume the purges that stopped half way (`resumePurges`), ask the server and decide (`decide`), carry the
 * plan out (`execute`) when it has anything to do. It runs for
 *  - a successful work-package refresh (`trigger('refresh')`), a successful token refresh (`'token'`), the app returning to
 *    the foreground, the network coming back, the offline lock being lifted, a manual request, and a replayer that met a 403
 *    or 404 on a write bound to an inspection (`onNeedsReconcile`), all of them through `trigger`;
 *  - a slow timer as a fallback, only while started.
 *
 * It NEVER runs while the offline lock holds, the device is revoked, expired or its clock is wrong (one `isLocked`), or
 * the device is offline: the gate is checked before the flow, after the resume and before the plan is carried out, so a
 * lock that arrives mid-flow stops it before the next step.
 *
 * Single flight: one flow at a time. Triggers that arrive meanwhile make exactly ONE follow-up run, however many they are.
 *
 * No loops: an outcome that cannot improve by asking again soon (the role may not reconcile, a queued write names no
 * inspection, the server refuses, the app is too old) or that keeps failing holds the AUTOMATIC triggers back for a time
 * that doubles with every failure up to an hour (the role and null-id refusals hold for the whole hour at once). A held
 * trigger waits for the one timer that is armed for the end of the hold. A person asking (`manual`), the lock being
 * lifted (`unlock`) and a token refresh (`token`: the thing that was wrong may have just been fixed) go through the hold.
 * A lock or being offline is not a failure and holds nothing: the event that ends it runs the flow at once.
 *
 * There is at most one timer. Every run replaces it; `stop()` clears it and is terminal.
 */

export type ReconcileReason = 'start' | 'online' | 'foreground' | 'unlock' | 'manual' | 'token' | 'refresh' | 'needs_reconcile' | 'fallback' | 'follow_up';

export type OutcomeStatus = 'never' | 'skipped' | 'done' | 'stopped' | 'unavailable' | 'refused' | 'failed' | 'auth' | 'halt' | 'busy' | 'error';

export interface ReconcileCounts {
  purged: number;
  quarantined: number;
  unquarantined: number;
  deferred: number;
  skippedChanged: number;
  failed: number;
}

/** What the interface needs to know about the latest flow. Fixed codes and numbers only: no id, path or message ever. */
export interface ReconcileOutcome {
  status: OutcomeStatus;
  /** A fixed code that refines the status (`locked`, `offline`, `role`, `null_inspection_id`, `stale_plan`, ...), or null. */
  reason: string | null;
  /** The injected-clock time the flow ended, or null before the first one. */
  at: number | null;
  /** The server's answer would have removed (nearly) everything: the affected inspections were quarantined, not purged. */
  massSuspicious: boolean;
  /** The server listed none of the inspections the device asked about. */
  allMissing: boolean;
  /** Inspections sent to the server in the last request series. */
  candidateCount: number;
  /** This member's role may not use the visibility check (office staff): not an error, nothing to show as one. */
  unavailableRole: boolean;
  /** A queued write names no inspection, so reconciliation refuses until the person deals with it. */
  refusedNullInspectionId: boolean;
  counts: ReconcileCounts | null;
  /** Purges that had stopped half way and were finished at the start of this flow. */
  resumed: number;
  /** A stopped purge could not be finished (or the resume itself failed). */
  resumeFailed: boolean;
}

export interface ReconcilerDeps {
  /** `decideReconcile` over its dependencies. */
  decide(): Promise<ReconcileResult>;
  /** `executeReconcilePlan` over its dependencies. */
  execute(plan: ReconcilePlan): Promise<ExecuteResult>;
  /** `resumePurges` over its dependencies. */
  resumePurges(): Promise<ResumeSummary>;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  /** Calls the listener whenever the device becomes unlocked; returns the unsubscribe function. */
  onUnlocked?: (listener: () => void) => () => void;
  network: Pick<Network, 'online' | 'onChange'>;
  appState?: AppStatePort;
  clock: Clock;
  timers?: TimerPort;
  /** The slow fallback. Default 10 minutes; never below one second or above a day; jittered to 75% to 125%. */
  fallbackIntervalMs?: number;
  /** Source of the jitter; tests only. */
  random?: () => number;
  /** Receives every finished flow's outcome. A throw is ignored. */
  onOutcome?: (outcome: ReconcileOutcome) => void;
  /** Receives unexpected failures. Never receives a plan, an id or a path. */
  onError?: (error: unknown) => void;
}

export interface Reconciler {
  /** Asks for a flow. Coalesced; see the module comment. Ignored after `stop()`. */
  trigger(reason: ReconcileReason): void;
  /** For the replayer's `onNeedsReconcile`: a write was refused for an inspection the server may no longer show. */
  onNeedsReconcile(inspectionId: string): void;
  /** Runs now, then on the network coming back, on the foreground, on unlock, and on the slow timer. */
  start(): void;
  /** Terminal: no further flow, no timer, no subscription. */
  stop(): void;
  /** Settles when no flow is running or queued. */
  idle(): Promise<void>;
  /** The latest outcome (`status: 'never'` before the first flow). */
  readonly last: ReconcileOutcome;
}

export const DEFAULT_RECONCILER_FALLBACK_MS = 600_000;
const MIN_TIMER_MS = 1000;
const MAX_TIMER_MS = 86_400_000;
export const HOLD_BASE_MS = 30_000;
export const HOLD_BUSY_BASE_MS = 5_000;
export const HOLD_MAX_MS = 3_600_000;

/** Reasons that say something changed, so they are not held back by a hold. */
const THROUGH_THE_HOLD: ReadonlySet<ReconcileReason> = new Set<ReconcileReason>(['manual', 'unlock', 'token']);

type Failure = { kind: 'ok' } | { kind: 'neutral' } | { kind: 'soft'; retryAfterMs: number | null } | { kind: 'busy' } | { kind: 'permanent' };

interface Flow {
  outcome: Omit<ReconcileOutcome, 'at'>;
  failure: Failure;
}

function blank(): Omit<ReconcileOutcome, 'at'> {
  return { status: 'never', reason: null, massSuspicious: false, allMissing: false, candidateCount: 0, unavailableRole: false, refusedNullInspectionId: false, counts: null, resumed: 0, resumeFailed: false };
}

export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const fallbackInterval = Math.max(MIN_TIMER_MS, Math.min(deps.fallbackIntervalMs ?? DEFAULT_RECONCILER_FALLBACK_MS, MAX_TIMER_MS));
  let stopped = false;
  let started = false;
  let running: Promise<void> | null = null;
  let again = false;
  let againThroughHold = false;
  let timer: unknown = null;
  let failures = 0;
  let holdUntil = 0;
  let latest: ReconcileOutcome = { ...blank(), at: null };
  const unsubscribe: (() => void)[] = [];

  function report(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // A failing reporter must not change what the flow does.
    }
  }

  /** Why the flow may not go on right now, or null when it may. */
  async function closed(): Promise<'locked' | 'offline' | 'stopped' | null> {
    if (stopped) return 'stopped';
    try {
      if ((await deps.isLocked()) !== false) return 'locked';
    } catch {
      return 'locked';
    }
    try {
      if (!(await deps.network.online())) return 'offline';
    } catch {
      return 'offline';
    }
    return stopped ? 'stopped' : null;
  }

  function skipped(reason: string, resumed: number, resumeFailed: boolean): Flow {
    return { outcome: { ...blank(), status: 'skipped', reason, resumed, resumeFailed }, failure: { kind: 'neutral' } };
  }

  function fromPlan(plan: ReconcilePlan, resumed: number, resumeFailed: boolean): Omit<ReconcileOutcome, 'at'> {
    const counts: ReconcileCounts = { purged: 0, quarantined: 0, unquarantined: 0, deferred: 0, skippedChanged: 0, failed: 0 };
    return { ...blank(), status: 'done', massSuspicious: plan.massSuspicious, allMissing: plan.allMissing, candidateCount: plan.candidateCount, counts, resumed, resumeFailed };
  }

  function fromNonPlan(answer: Exclude<ReconcileResult, ReconcilePlan>, resumed: number, resumeFailed: boolean): Flow {
    const base = { ...blank(), resumed, resumeFailed };
    switch (answer.kind) {
      case 'busy':
        return { outcome: { ...base, status: 'busy' }, failure: { kind: 'busy' } };
      case 'lease_lost':
        return { outcome: { ...base, status: 'busy', reason: 'lease_lost' }, failure: { kind: 'busy' } };
      case 'locked':
        return { outcome: { ...base, status: 'skipped', reason: 'locked' }, failure: { kind: 'neutral' } };
      case 'no_account':
        return { outcome: { ...base, status: 'skipped', reason: 'no_account' }, failure: { kind: 'neutral' } };
      case 'account_mismatch':
        return { outcome: { ...base, status: 'failed', reason: 'account_mismatch' }, failure: { kind: 'soft', retryAfterMs: null } };
      case 'unavailable':
        return { outcome: { ...base, status: 'unavailable', reason: answer.reason, unavailableRole: true }, failure: { kind: 'permanent' } };
      case 'auth':
        return { outcome: { ...base, status: 'auth' }, failure: { kind: 'soft', retryAfterMs: null } };
      case 'halt':
        return { outcome: { ...base, status: 'halt', reason: answer.reason }, failure: { kind: 'permanent' } };
      case 'failed':
        return { outcome: { ...base, status: 'failed', reason: answer.reason }, failure: { kind: 'soft', retryAfterMs: answer.retryAfterMs } };
      case 'invalid':
        return { outcome: { ...base, status: 'failed', reason: answer.reason }, failure: { kind: 'soft', retryAfterMs: null } };
      case 'refused':
        return { outcome: { ...base, status: 'refused', reason: answer.reason, refusedNullInspectionId: true }, failure: { kind: 'permanent' } };
    }
  }

  function fromExecution(plan: ReconcilePlan, result: ExecuteResult, resumed: number, resumeFailed: boolean): Flow {
    const { summary } = result;
    const counts: ReconcileCounts = { purged: summary.purged, quarantined: summary.quarantined, unquarantined: summary.unquarantined, deferred: summary.deferred, skippedChanged: summary.skippedChanged, failed: summary.failed };
    const base = { ...fromPlan(plan, resumed, resumeFailed), counts };
    if (result.kind === 'done') return { outcome: base, failure: summary.failed > 0 ? { kind: 'soft', retryAfterMs: null } : { kind: 'ok' } };
    const failure: Failure = result.reason === 'locked' || result.reason === 'no_account' ? { kind: 'neutral' } : result.reason === 'busy' || result.reason === 'lease_lost' ? { kind: 'busy' } : { kind: 'soft', retryAfterMs: null };
    return { outcome: { ...base, status: 'stopped', reason: result.reason }, failure };
  }

  async function flow(): Promise<Flow> {
    const first = await closed();
    if (first !== null) return skipped(first, 0, false);

    let resumed = 0;
    let resumeFailed = false;
    try {
      const summary = await deps.resumePurges();
      resumed = summary.resumed;
      resumeFailed = summary.failed > 0;
    } catch (error) {
      resumeFailed = true;
      report(error);
    }
    const afterResume = await closed();
    if (afterResume !== null) return skipped(afterResume, resumed, resumeFailed);

    let answer: ReconcileResult;
    try {
      answer = await deps.decide();
    } catch (error) {
      report(error);
      return { outcome: { ...blank(), status: 'error', reason: 'decide_threw', resumed, resumeFailed }, failure: { kind: 'soft', retryAfterMs: null } };
    }
    if (answer.kind !== 'plan') return fromNonPlan(answer, resumed, resumeFailed);

    if (answer.purge.length + answer.quarantine.length + answer.unquarantine.length === 0) {
      return { outcome: fromPlan(answer, resumed, resumeFailed), failure: { kind: 'ok' } };
    }
    const beforeExecute = await closed();
    if (beforeExecute !== null) return skipped(beforeExecute, resumed, resumeFailed);
    let result: ExecuteResult;
    try {
      result = await deps.execute(answer);
    } catch (error) {
      report(error);
      return { outcome: { ...fromPlan(answer, resumed, resumeFailed), status: 'error', reason: 'execute_threw' }, failure: { kind: 'soft', retryAfterMs: null } };
    }
    return fromExecution(answer, result, resumed, resumeFailed);
  }

  function jitter(): number {
    return 0.5 + 0.5 * random();
  }

  function applyFailure(failure: Failure): void {
    const now = deps.clock.now();
    if (failure.kind === 'ok') {
      failures = 0;
      holdUntil = 0;
      return;
    }
    if (failure.kind === 'neutral') return;
    failures += 1;
    let hold: number;
    if (failure.kind === 'permanent') hold = HOLD_MAX_MS;
    else {
      const base = failure.kind === 'busy' ? HOLD_BUSY_BASE_MS : HOLD_BASE_MS;
      hold = Math.round(Math.min(base * 2 ** Math.min(failures - 1, 20), HOLD_MAX_MS) * jitter());
      if (failure.kind === 'soft' && failure.retryAfterMs !== null) hold = Math.max(hold, Math.min(failure.retryAfterMs, HOLD_MAX_MS));
    }
    holdUntil = now + hold;
  }

  /** The ONE timer: the slow fallback while started, never earlier than the end of a hold. */
  function arm(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (stopped) return;
    const held = Math.max(0, holdUntil - deps.clock.now());
    if (!started && held === 0) return;
    const slow = started ? Math.round(fallbackInterval * (0.75 + 0.5 * random())) : 0;
    const delay = Math.max(MIN_TIMER_MS, Math.min(Math.max(slow, held), MAX_TIMER_MS));
    timer = timers.setTimeout(() => {
      timer = null;
      trigger('fallback');
    }, delay);
  }

  function finish(result: Flow): void {
    latest = { ...result.outcome, at: deps.clock.now() };
    applyFailure(result.failure);
    try {
      deps.onOutcome?.(latest);
    } catch {
      // A failing listener must not change what the flow does.
    }
  }

  function begin(): void {
    const flight: Promise<void> = (async () => {
      let result: Flow;
      try {
        result = await flow();
      } catch (error) {
        report(error);
        result = { outcome: { ...blank(), status: 'error', reason: 'flow_threw' }, failure: { kind: 'soft', retryAfterMs: null } };
      }
      finish(result);
      arm();
    })().finally(() => {
      running = null;
      if (again && !stopped) {
        const through = againThroughHold;
        again = false;
        againThroughHold = false;
        trigger(through ? 'manual' : 'follow_up');
      }
    });
    running = flight;
  }

  function trigger(reason: ReconcileReason): void {
    if (stopped) return;
    if (running !== null) {
      again = true;
      if (THROUGH_THE_HOLD.has(reason)) againThroughHold = true;
      return;
    }
    if (!THROUGH_THE_HOLD.has(reason) && deps.clock.now() < holdUntil) {
      if (timer === null) arm();
      return;
    }
    begin();
  }

  return {
    trigger,
    onNeedsReconcile: () => {
      trigger('needs_reconcile');
    },
    start: () => {
      if (started || stopped) return;
      started = true;
      unsubscribe.push(
        deps.network.onChange((online) => {
          if (online) trigger('online');
        }),
      );
      if (deps.appState) {
        unsubscribe.push(
          deps.appState.onChange((active) => {
            if (active) trigger('foreground');
          }),
        );
      }
      if (deps.onUnlocked) unsubscribe.push(deps.onUnlocked(() => trigger('unlock')));
      trigger('start');
    },
    stop: () => {
      stopped = true;
      for (const off of unsubscribe.splice(0)) off();
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
    idle: async () => {
      while (running !== null) await running.catch(() => undefined);
    },
    get last() {
      return latest;
    },
  };
}
