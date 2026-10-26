import { describe, expect, it } from 'vitest';
import type { TimerPort } from '../collab/timers';
import type { ReconcileOutcome } from '../offline/reconciler';
import { reconcileGateFor, type GateReconciler } from './reconcile-gate';

function outcome(patch: Partial<ReconcileOutcome>): ReconcileOutcome {
  return { status: 'done', reason: null, at: 1, massSuspicious: false, allMissing: false, candidateCount: 0, unavailableRole: false, refusedNullInspectionId: false, counts: null, resumed: 0, resumeFailed: false, ...patch };
}

/** A reconciler whose triggered flow ends with the given outcome, or with no new outcome at all. */
function fake(result: ReconcileOutcome | null, before: ReconcileOutcome = outcome({ status: 'never', at: null })): GateReconciler & { triggers: string[] } {
  let latest = before;
  const triggers: string[] = [];
  return {
    triggers,
    trigger: (reason) => {
      triggers.push(reason);
      if (result !== null) latest = { ...result };
    },
    idle: () => Promise.resolve(),
    get last() {
      return latest;
    },
  };
}

describe('the reconcile before an export', () => {
  it('is confirmed when a fresh flow ended done', async () => {
    const reconciler = fake(outcome({ status: 'done' }));
    expect(await reconcileGateFor(reconciler)()).toBe(true);
    expect(reconciler.triggers).toEqual(['manual']);
  });

  it('is confirmed even when the previous outcome was also done: freshness is a new outcome, not a different one', async () => {
    expect(await reconcileGateFor(fake(outcome({ status: 'done' }), outcome({ status: 'done' })))()).toBe(true);
  });

  it('is not confirmed when no new flow ended (the stack stopped, the trigger was ignored)', async () => {
    expect(await reconcileGateFor(fake(null, outcome({ status: 'done' })))()).toBe(false);
  });

  it.each([
    ['being offline', outcome({ status: 'skipped', reason: 'offline' })],
    ['a lock', outcome({ status: 'skipped', reason: 'locked' })],
    ['the server refusing', outcome({ status: 'failed', reason: 'server' })],
    ['a sign-in problem', outcome({ status: 'auth' })],
    ['an unsupported server', outcome({ status: 'unavailable', reason: 'unsupported' })],
    ['a role that may not ask', outcome({ status: 'unavailable', reason: 'role' })],
    ['a halt', outcome({ status: 'halt', reason: 'too_old' })],
    ['a flow that threw', outcome({ status: 'error', reason: 'flow_threw' })],
    ['a flow that stopped half way', outcome({ status: 'stopped', reason: 'locked' })],
  ])('is not confirmed after %s', async (_name, result) => {
    expect(await reconcileGateFor(fake(result))()).toBe(false);
  });

  it('is not confirmed when the reconciler cannot be waited on or throws', async () => {
    const throwing: GateReconciler = {
      trigger: () => {
        throw new Error('boom');
      },
      idle: () => Promise.resolve(),
      last: outcome({}),
    };
    expect(await reconcileGateFor(throwing)()).toBe(false);
    const noIdle: GateReconciler = { trigger: () => undefined, last: outcome({}) };
    expect(await reconcileGateFor(noIdle)()).toBe(false);
  });

  it('gives up after the time allowed, so a slow server cannot hold the export back', async () => {
    let pending: (() => void) | null = null;
    const timers: TimerPort = {
      setTimeout: (callback) => {
        pending = callback;
        return 1;
      },
      clearTimeout: () => {
        pending = null;
      },
    };
    const stuck: GateReconciler = { trigger: () => undefined, idle: () => new Promise<void>(() => undefined), last: outcome({}) };
    const asked = reconcileGateFor(stuck, { timers, timeoutMs: 5000 })();
    expect(pending).not.toBeNull();
    (pending as unknown as () => void)();
    expect(await asked).toBe(false);
  });
});
