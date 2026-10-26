import { realTimers, type TimerPort } from '../collab/timers';
import type { ReconcileOutcome, ReconcileReason } from '../offline/reconciler';

/** Answers whether the server confirmed which inspections still exist. Never rejects. */
export type ReconcileGate = () => Promise<boolean>;

/** The part of the reconciler the export uses. `idle` is optional only because a test double may lack it; without it nothing is confirmed. */
export interface GateReconciler {
  trigger(reason: ReconcileReason): void;
  idle?(): Promise<void>;
  readonly last: ReconcileOutcome;
}

/** The longest an export waits for the server's answer before it goes on without one. */
export const RECONCILE_WAIT_MS = 15_000;

/**
 * Runs one reconcile and says whether it confirmed the list. Confirmed means a NEW flow ended `done` (a different outcome than the
 * one there was before, so an old success is never reused) and it is `done`, which a server that cannot answer never reaches (`unsupported` ends `unavailable`).
 * Offline, locked, a refusal, a sign-in problem, a timeout or a thrown error all mean "not confirmed", which the export treats as
 * "export everything and warn", never as a reason to stop.
 */
export function reconcileGateFor(reconciler: GateReconciler, options: { timers?: TimerPort; timeoutMs?: number } = {}): ReconcileGate {
  const timers = options.timers ?? realTimers;
  const timeoutMs = options.timeoutMs ?? RECONCILE_WAIT_MS;
  return async () => {
    try {
      const before = reconciler.last;
      reconciler.trigger('manual');
      if (reconciler.idle === undefined) return false;
      let handle: unknown = null;
      const timeout = new Promise<'timeout'>((resolve) => {
        handle = timers.setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const settled = reconciler.idle().then(() => 'idle' as const);
      const first = await Promise.race([settled, timeout]);
      timers.clearTimeout(handle);
      if (first === 'timeout') return false;
      const after = reconciler.last;
      // `done` is the only status that carries the server's answer: a server without the check ends `unavailable` (`isReconcileUnsupported`).
      return after !== before && after.status === 'done';
    } catch {
      return false;
    }
  };
}
