import { describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createManualClock } from '../platform/clock';
import type { ReconcilePlan, ReconcileResult } from './reconcile-decision';
import type { ExecuteResult, ExecuteSummary } from './reconcile-execute';
import { createReconciler, isReconcileUnsupported, type ReconcilerDeps, type ReconcileOutcome } from './reconciler';
import type { ResumeSummary } from './purge';
import { fakeAppState } from './test-support/fakes';
import { ALICE } from './test-support/reconcile-world';

const NOW = 1_000_000;

function plan(overrides: Partial<ReconcilePlan> = {}): ReconcilePlan {
  return {
    kind: 'plan',
    purge: [],
    quarantine: [],
    unquarantine: [],
    keep: [],
    deferred: [],
    unknownOwner: [],
    massSuspicious: false,
    allMissing: false,
    candidateCount: 10,
    account: ALICE,
    decidedAt: NOW,
    fingerprints: {},
    reasons: {},
    proof: { candidates: 10, requests: 1, visible: 10, missing: 0, excluded: { invalidId: 0, purging: 0, unconfirmed: 0, createPending: 0, unknownOwner: 0 }, truncated: false, unsent: {}, convertedToQuarantine: 0 },
    ...overrides,
  };
}

const summary = (overrides: Partial<ExecuteSummary> = {}): ExecuteSummary => ({ purged: 0, quarantined: 0, unquarantined: 0, deferred: 0, skippedChanged: 0, failed: 0, failures: {}, ...overrides });
const resumed = (overrides: Partial<ResumeSummary> = {}): ResumeSummary => ({ resumed: 0, failed: 0, foreign: 0, stopped: null, failures: {}, ...overrides });

interface World {
  clock: ReturnType<typeof createManualClock>;
  timers: ReturnType<typeof createManualTimers>;
  appState: ReturnType<typeof fakeAppState>;
  calls: string[];
  state: { locked: boolean; lockedThrows: boolean; online: boolean; onlineThrows: boolean };
  decisions: (ReconcileResult | Error | (() => Promise<ReconcileResult>))[];
  executions: (ExecuteResult | Error)[];
  resumes: (ResumeSummary | Error)[];
  outcomes: ReconcileOutcome[];
  errors: unknown[];
  network: ReconcilerDeps['network'] & { set(online: boolean): void; listeners(): number };
  unlockListeners: Set<() => void>;
  reconciler: ReturnType<typeof createReconciler>;
}

function createWorld(options: { fallbackIntervalMs?: number; omitAppState?: boolean } = {}): World {
  const clock = createManualClock(NOW);
  const timers = createManualTimers();
  const appState = fakeAppState();
  const calls: string[] = [];
  const state = { locked: false, lockedThrows: false, online: true, onlineThrows: false };
  const listeners = new Set<(online: boolean) => void>();
  const unlockListeners = new Set<() => void>();
  const world = { clock, timers, appState, calls, state, decisions: [], executions: [], resumes: [], outcomes: [], errors: [], unlockListeners } as unknown as World;
  const network = {
    online: () => (state.onlineThrows ? Promise.reject(new Error('no answer')) : Promise.resolve(state.online)),
    onChange: (cb: (online: boolean) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(online: boolean) {
      state.online = online;
      for (const l of [...listeners]) l(online);
    },
    listeners: () => listeners.size,
  };
  world.network = network;
  world.reconciler = createReconciler({
    decide: async () => {
      calls.push('decide');
      const next = world.decisions.shift() ?? plan();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
    execute: async (p) => {
      calls.push(`execute:${p.purge.length}/${p.quarantine.length}/${p.unquarantine.length}`);
      const next = world.executions.shift() ?? { kind: 'done', summary: summary() };
      if (next instanceof Error) throw next;
      return next;
    },
    resumePurges: async () => {
      calls.push('resume');
      const next = world.resumes.shift() ?? resumed();
      if (next instanceof Error) throw next;
      return next;
    },
    isLocked: () => {
      if (state.lockedThrows) throw new Error('lock unreadable');
      return state.locked;
    },
    onUnlocked: (listener) => {
      unlockListeners.add(listener);
      return () => unlockListeners.delete(listener);
    },
    network,
    ...(options.omitAppState === true ? {} : { appState }),
    clock,
    timers,
    random: () => 0.5,
    ...(options.fallbackIntervalMs === undefined ? {} : { fallbackIntervalMs: options.fallbackIntervalMs }),
    onOutcome: (outcome) => world.outcomes.push(outcome),
    onError: (error) => world.errors.push(error),
  });
  return world;
}

async function run(w: World, reason: Parameters<World['reconciler']['trigger']>[0] = 'manual'): Promise<void> {
  w.reconciler.trigger(reason);
  await w.reconciler.idle();
}

describe('one flow: resume, decide, execute', () => {
  it('resumes first, decides, executes a plan that has something to do, and reports the counts and the plan flags as fixed fields', async () => {
    const w = createWorld();
    w.decisions.push(plan({ purge: ['a'], quarantine: ['b'], unquarantine: ['c'], massSuspicious: false, allMissing: false, candidateCount: 12 }));
    w.executions.push({ kind: 'done', summary: summary({ purged: 1, quarantined: 1, unquarantined: 1 }) });
    w.resumes.push(resumed({ resumed: 2 }));
    await run(w);
    expect(w.calls).toEqual(['resume', 'decide', 'execute:1/1/1']);
    expect(w.reconciler.last).toMatchObject({
      status: 'done',
      reason: null,
      massSuspicious: false,
      allMissing: false,
      candidateCount: 12,
      unavailableRole: false,
      refusedNullInspectionId: false,
      counts: { purged: 1, quarantined: 1, unquarantined: 1, deferred: 0, skippedChanged: 0, failed: 0 },
      resumed: 2,
      at: NOW,
    });
    expect(w.outcomes).toHaveLength(1);
  });

  it('a plan with nothing to do is not executed', async () => {
    const w = createWorld();
    await run(w);
    expect(w.calls).toEqual(['resume', 'decide']);
    expect(w.reconciler.last).toMatchObject({ status: 'done', counts: { purged: 0, quarantined: 0 } });
  });

  it('carries the suspicious-answer flags to the outcome', async () => {
    const w = createWorld();
    w.decisions.push(plan({ quarantine: ['a', 'b', 'c'], massSuspicious: true, allMissing: true, candidateCount: 3 }));
    w.executions.push({ kind: 'done', summary: summary({ quarantined: 3 }) });
    await run(w);
    expect(w.reconciler.last).toMatchObject({ massSuspicious: true, allMissing: true, candidateCount: 3, counts: { quarantined: 3 } });
  });

  it.each([
    [{ kind: 'unavailable', reason: 'role' } as ReconcileResult, { status: 'unavailable', reason: 'role', unavailableRole: true }],
    [{ kind: 'unavailable', reason: 'unsupported' } as ReconcileResult, { status: 'unavailable', reason: 'unsupported', unavailableRole: false }],
    [{ kind: 'refused', reason: 'null_inspection_id' } as ReconcileResult, { status: 'refused', reason: 'null_inspection_id', refusedNullInspectionId: true }],
    [{ kind: 'auth' } as ReconcileResult, { status: 'auth', reason: null }],
    [{ kind: 'halt', reason: 'upgrade_required' } as ReconcileResult, { status: 'halt', reason: 'upgrade_required' }],
    [{ kind: 'failed', reason: 'timeout', retryAfterMs: null } as ReconcileResult, { status: 'failed', reason: 'timeout' }],
    [{ kind: 'invalid', reason: 'bad_response' } as ReconcileResult, { status: 'failed', reason: 'bad_response' }],
    [{ kind: 'busy' } as ReconcileResult, { status: 'busy', reason: null }],
    [{ kind: 'locked' } as ReconcileResult, { status: 'skipped', reason: 'locked' }],
    [{ kind: 'lease_lost' } as ReconcileResult, { status: 'busy', reason: 'lease_lost' }],
    [{ kind: 'no_account' } as ReconcileResult, { status: 'skipped', reason: 'no_account' }],
    [{ kind: 'account_mismatch' } as ReconcileResult, { status: 'failed', reason: 'account_mismatch' }],
  ])('a non-plan answer %j executes nothing and is reported as %j', async (answer, expected) => {
    const w = createWorld();
    w.decisions.push(answer);
    await run(w);
    expect(w.calls).toEqual(['resume', 'decide']);
    expect(w.reconciler.last).toMatchObject(expected);
  });

  it('a decision that throws is an error outcome, never an unhandled rejection, and executes nothing', async () => {
    const w = createWorld();
    w.decisions.push(new Error('boom /secret'));
    await run(w);
    expect(w.reconciler.last).toMatchObject({ status: 'error', reason: 'decide_threw' });
    expect(JSON.stringify(w.reconciler.last)).not.toContain('secret');
    expect(w.calls).toEqual(['resume', 'decide']);
  });

  it('an execution that throws is an error outcome', async () => {
    const w = createWorld();
    w.decisions.push(plan({ purge: ['a'] }));
    w.executions.push(new Error('boom'));
    await run(w);
    expect(w.reconciler.last).toMatchObject({ status: 'error', reason: 'execute_threw' });
  });

  it('a stopped execution is reported with its reason; a lock is not a failure', async () => {
    const w = createWorld();
    w.decisions.push(plan({ purge: ['a'] }));
    w.executions.push({ kind: 'stopped', reason: 'stale_plan', summary: summary() });
    await run(w);
    expect(w.reconciler.last).toMatchObject({ status: 'stopped', reason: 'stale_plan' });
  });

  it('a resume that throws or stops does not keep the decision from running', async () => {
    const w = createWorld();
    w.resumes.push(new Error('storage'));
    await run(w);
    expect(w.calls).toEqual(['resume', 'decide']);
    expect(w.reconciler.last.resumeFailed).toBe(true);
    w.resumes.push(resumed({ failed: 1, failures: { file_remove_failed: 1 } }));
    await run(w);
    expect(w.reconciler.last).toMatchObject({ resumeFailed: true });
    w.resumes.push(resumed({ resumed: 1 }));
    await run(w);
    expect(w.reconciler.last).toMatchObject({ resumeFailed: false, resumed: 1 });
  });
});

describe('never while locked, revoked, expired, offline', () => {
  it.each([
    ['locked', (w: World) => (w.state.locked = true), 'locked'],
    ['the lock cannot be read', (w: World) => (w.state.lockedThrows = true), 'locked'],
    ['offline', (w: World) => (w.state.online = false), 'offline'],
    ['the network cannot be read', (w: World) => (w.state.onlineThrows = true), 'offline'],
  ])('%s: nothing is called', async (_name, change, reason) => {
    const w = createWorld();
    change(w);
    await run(w);
    expect(w.calls).toEqual([]);
    expect(w.reconciler.last).toMatchObject({ status: 'skipped', reason });
  });

  it('control: unlocked and online runs the whole flow', async () => {
    const w = createWorld();
    await run(w);
    expect(w.calls).toEqual(['resume', 'decide']);
  });

  it('a lock that arrives while the decision runs keeps the plan from being executed', async () => {
    const w = createWorld();
    w.decisions.push(async () => {
      w.state.locked = true;
      return plan({ purge: ['a'] });
    });
    await run(w);
    expect(w.calls).toEqual(['resume', 'decide']);
    expect(w.reconciler.last).toMatchObject({ status: 'skipped', reason: 'locked' });
  });

  it('a network that drops while the resume runs keeps the decision from starting', async () => {
    const w = createWorld();
    const reconciler = createReconciler({
      decide: () => {
        w.calls.push('decide');
        return Promise.resolve(plan());
      },
      execute: () => Promise.resolve({ kind: 'done', summary: summary() } as ExecuteResult),
      resumePurges: () => {
        w.calls.push('resume');
        w.state.online = false;
        return Promise.resolve(resumed());
      },
      isLocked: () => false,
      network: w.network,
      clock: w.clock,
      timers: w.timers,
    });
    reconciler.trigger('manual');
    await reconciler.idle();
    expect(w.calls).toEqual(['resume']);
  });
});

describe('single flight and coalescing', () => {
  it('triggers during a run make exactly one follow-up run, however many there are', async () => {
    const w = createWorld();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    w.decisions.push(async () => {
      await held;
      return plan();
    });
    w.reconciler.trigger('refresh');
    for (let i = 0; i < 10; i += 1) w.reconciler.trigger('foreground');
    release();
    await w.reconciler.idle();
    expect(w.calls.filter((call) => call === 'decide')).toHaveLength(2);
    expect(w.calls.filter((call) => call === 'resume')).toHaveLength(2);
  });

  it('control: triggers with nothing running each start a run', async () => {
    const w = createWorld();
    await run(w, 'refresh');
    await run(w, 'foreground');
    await run(w, 'token');
    expect(w.calls.filter((call) => call === 'decide')).toHaveLength(3);
  });

  it('the follow-up sees the world as it is then: if the device locked meanwhile it does nothing', async () => {
    const w = createWorld();
    w.decisions.push(async () => {
      w.reconciler.trigger('foreground');
      w.state.locked = true;
      return plan();
    });
    await run(w, 'refresh');
    expect(w.calls.filter((call) => call === 'decide')).toHaveLength(1);
  });
});

describe('what starts a run', () => {
  it('start() runs once at once, then on the network coming back, on the foreground, on unlock, on a replayer request and on a token refresh; never on going offline or to the background', async () => {
    const w = createWorld();
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(1);
    w.network.set(false);
    w.appState.emit(false);
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(1);
    w.network.set(true);
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(2);
    w.appState.emit(true);
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(3);
    for (const listener of [...w.unlockListeners]) listener();
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(4);
    w.reconciler.onNeedsReconcile('some-inspection');
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(5);
    w.reconciler.trigger('token');
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(6);
    w.reconciler.trigger('refresh');
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(7);
  });

  it('start() twice subscribes once; stop() unsubscribes everything and is terminal', async () => {
    const w = createWorld();
    w.reconciler.start();
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.network.listeners()).toBe(1);
    expect(w.appState.listeners()).toBe(1);
    expect(w.unlockListeners.size).toBe(1);
    w.reconciler.stop();
    expect(w.network.listeners()).toBe(0);
    expect(w.appState.listeners()).toBe(0);
    expect(w.unlockListeners.size).toBe(0);
    const before = w.calls.length;
    w.reconciler.trigger('manual');
    w.reconciler.onNeedsReconcile('x');
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.calls.length).toBe(before);
    expect(w.timers.pending()).toBe(0);
  });

  it('works without an app-state source', async () => {
    const w = createWorld({ omitAppState: true });
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.calls).toEqual(['resume', 'decide']);
  });

  it('stop() during a run keeps the plan from being executed', async () => {
    const w = createWorld();
    w.decisions.push(async () => {
      w.reconciler.stop();
      return plan({ purge: ['a'] });
    });
    await run(w);
    expect(w.calls).toEqual(['resume', 'decide']);
  });
});

describe('the slow fallback timer', () => {
  it('is one timer, jittered, never below a second, replaced (not stacked) by every run, and cleared by stop', async () => {
    const w = createWorld({ fallbackIntervalMs: 600_000 });
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.timers.pending()).toBe(1);
    expect(w.timers.delays()).toEqual([600_000]);
    await run(w, 'refresh');
    await run(w, 'foreground');
    expect(w.timers.pending()).toBe(1);
    expect(w.timers.requested()).toHaveLength(3);
    w.reconciler.stop();
    expect(w.timers.pending()).toBe(0);
  });

  it('never goes below one second whatever it is asked for, and is not armed before start', async () => {
    const w = createWorld({ fallbackIntervalMs: 1 });
    await run(w);
    expect(w.timers.pending()).toBe(0);
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.timers.delays()[0]).toBeGreaterThanOrEqual(1000);
  });

  it('firing runs a reconcile and arms the next one: no tight loop, one run per firing', async () => {
    const w = createWorld({ fallbackIntervalMs: 60_000 });
    w.reconciler.start();
    await w.reconciler.idle();
    for (let i = 0; i < 5; i += 1) {
      w.timers.fireNext();
      await w.reconciler.idle();
    }
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(6);
    expect(w.timers.pending()).toBe(1);
    expect(w.timers.requested()).toHaveLength(6);
  });
});

describe('isReconcileUnsupported: the predicate the export (Task 11) reads as "cannot confirm"', () => {
  const base = { status: 'unavailable', reason: 'unsupported' } as Pick<ReconcileOutcome, 'status' | 'reason'>;
  it('is true only for an unavailable outcome whose reason is unsupported', () => {
    expect(isReconcileUnsupported(base)).toBe(true);
    expect(isReconcileUnsupported({ status: 'unavailable', reason: 'role' })).toBe(false);
    expect(isReconcileUnsupported({ status: 'failed', reason: 'unsupported' })).toBe(false);
    expect(isReconcileUnsupported({ status: 'never', reason: null })).toBe(false);
  });
});

describe('a refused or unavailable outcome does not retrigger in a loop', () => {
  it('holds the automatic triggers for a growing time, lets a person and an unlock through, and resets after a good run', async () => {
    const w = createWorld({ fallbackIntervalMs: 600_000 });
    w.reconciler.start();
    w.decisions.push({ kind: 'refused', reason: 'null_inspection_id' });
    await w.reconciler.idle();
    expect(w.reconciler.last.status).toBe('refused');
    const decides = (): number => w.calls.filter((c) => c === 'decide').length;
    expect(decides()).toBe(1);
    // Automatic triggers inside the hold do not run; they wait for the hold to end with ONE timer.
    for (const reason of ['refresh', 'foreground', 'needs_reconcile', 'online'] as const) w.reconciler.trigger(reason);
    await w.reconciler.idle();
    expect(decides()).toBe(1);
    expect(w.timers.pending()).toBe(1);
    // A person asking, or an unlock, is not held back.
    w.decisions.push({ kind: 'refused', reason: 'null_inspection_id' });
    await run(w, 'manual');
    expect(decides()).toBe(2);
    w.decisions.push(plan());
    await run(w, 'unlock');
    expect(decides()).toBe(3);
    // After the good run the hold is gone.
    await run(w, 'refresh');
    expect(decides()).toBe(4);
  });

  it('the hold doubles with each failure up to an hour and a role refusal holds for the maximum at once', async () => {
    const w = createWorld({ fallbackIntervalMs: 1000 });
    w.reconciler.start();
    const holds: number[] = [];
    const measure = async (answer: ReconcileResult): Promise<void> => {
      w.decisions.push(answer);
      await run(w, 'manual');
      holds.push(w.timers.delays().at(-1) ?? 0);
    };
    w.decisions.push({ kind: 'failed', reason: 'timeout', retryAfterMs: null });
    await w.reconciler.idle();
    const first = w.timers.delays().at(-1) ?? 0;
    await measure({ kind: 'failed', reason: 'timeout', retryAfterMs: null });
    await measure({ kind: 'failed', reason: 'timeout', retryAfterMs: null });
    await measure({ kind: 'failed', reason: 'timeout', retryAfterMs: null });
    expect(holds[0]).toBeGreaterThan(first);
    expect(holds[1]).toBeGreaterThan(holds[0] ?? 0);
    await measure({ kind: 'unavailable', reason: 'role' });
    expect(holds.at(-1)).toBe(3_600_000);
    await measure({ kind: 'unavailable', reason: 'unsupported' });
    expect(holds.at(-1)).toBe(3_600_000);
  });

  it('a Retry-After from the server lengthens the hold', async () => {
    const w = createWorld({ fallbackIntervalMs: 60_000 });
    w.reconciler.start();
    w.decisions.push({ kind: 'failed', reason: 'rate_limited', retryAfterMs: 900_000 });
    await w.reconciler.idle();
    expect(w.timers.delays().at(-1)).toBeGreaterThanOrEqual(900_000);
  });

  it('when the hold ends the timer runs the reconcile once', async () => {
    const w = createWorld({ fallbackIntervalMs: 60_000 });
    w.reconciler.start();
    w.decisions.push({ kind: 'refused', reason: 'null_inspection_id' });
    await w.reconciler.idle();
    w.reconciler.trigger('refresh');
    await w.reconciler.idle();
    const delay = w.timers.delays().at(-1) ?? 0;
    w.clock.advance(delay + 1);
    w.timers.fireNext();
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(2);
    expect(w.reconciler.last.status).toBe('done');
  });

  it('a run that carried out a plan with failures backs off too', async () => {
    const w = createWorld({ fallbackIntervalMs: 60_000 });
    w.reconciler.start();
    w.decisions.push(plan({ purge: ['a'] }));
    w.executions.push({ kind: 'done', summary: summary({ failed: 1, failures: { file_remove_failed: 1 } }) });
    await w.reconciler.idle();
    w.reconciler.trigger('refresh');
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(1);
  });

  it('a lock or an offline skip is not a failure: nothing is held, the event that ends it runs at once', async () => {
    const w = createWorld({ fallbackIntervalMs: 600_000 });
    w.state.locked = true;
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.calls).toEqual([]);
    w.state.locked = false;
    w.reconciler.trigger('refresh');
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide')).toHaveLength(1);
  });
});

describe('the outcome object', () => {
  it('starts as "never" and keeps no free text', async () => {
    const w = createWorld();
    expect(w.reconciler.last).toMatchObject({ status: 'never', at: null, reason: null, counts: null, resumed: 0 });
    w.decisions.push(plan({ purge: ['secret-looking-id'] }));
    w.executions.push({ kind: 'done', summary: summary({ failed: 1, failures: { some_code: 1 } }) });
    await run(w);
    expect(JSON.stringify(w.reconciler.last)).not.toContain('secret-looking-id');
  });

  it('reports each outcome to the listener once, and a listener that throws changes nothing', async () => {
    const w = createWorld();
    const spy = vi.fn();
    const reconciler = createReconciler({
      decide: () => Promise.resolve(plan()),
      execute: () => Promise.resolve({ kind: 'done', summary: summary() } as ExecuteResult),
      resumePurges: () => Promise.resolve(resumed()),
      isLocked: () => false,
      network: w.network,
      clock: w.clock,
      timers: w.timers,
      onOutcome: (outcome) => {
        spy(outcome.status);
        throw new Error('listener failed');
      },
    });
    reconciler.trigger('manual');
    await reconciler.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(reconciler.last.status).toBe('done');
  });
});

describe('the first flow after start', () => {
  it('is not held back by a hold that an earlier trigger set before start()', async () => {
    const w = createWorld({ fallbackIntervalMs: 600_000 });
    // A busy answer to a trigger that arrives before start() sets a hold ...
    w.decisions.push({ kind: 'busy' });
    w.reconciler.trigger('needs_reconcile');
    await w.reconciler.idle();
    expect(w.reconciler.last.status).toBe('busy');
    const decides = (): number => w.calls.filter((c) => c === 'decide').length;
    expect(decides()).toBe(1);
    // ... and start() must still run its own first flow, which is the point of start.
    w.decisions.push(plan());
    w.reconciler.start();
    await w.reconciler.idle();
    expect(decides()).toBe(2);
    expect(w.reconciler.last.status).toBe('done');
  });

  it('control: an ordinary automatic trigger inside the same hold is still held back', async () => {
    const w = createWorld({ fallbackIntervalMs: 600_000 });
    w.decisions.push({ kind: 'busy' });
    w.reconciler.trigger('needs_reconcile');
    await w.reconciler.idle();
    w.reconciler.trigger('refresh');
    await w.reconciler.idle();
    expect(w.calls.filter((c) => c === 'decide').length).toBe(1);
  });
});
