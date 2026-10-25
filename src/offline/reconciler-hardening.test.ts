import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualTimers, type ManualTimers } from '../collab/test-support/manual-timers';
import type { TimerPort } from '../collab/timers';
import { createManualClock } from '../platform/clock';
import type { ReconcilePlan, ReconcileResult } from './reconcile-decision';
import type { ExecuteResult } from './reconcile-execute';
import { createReconciler, HOLD_MAX_MS, type ReconcileOutcome, type ReconcileReason, type Reconciler, type ReconcilerErrorCode } from './reconciler';
import { ALICE } from './test-support/reconcile-world';

const NOW = 1_000_000;
const FAILED: ReconcileResult = { kind: 'failed', reason: 'network', retryAfterMs: null };

function emptyPlan(): ReconcilePlan {
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
    candidateCount: 1,
    account: ALICE,
    decidedAt: NOW,
    fingerprints: {},
    reasons: {},
    proof: { candidates: 1, requests: 1, visible: 1, missing: 0, excluded: { invalidId: 0, purging: 0, unconfirmed: 0, createPending: 0, unknownOwner: 0 }, truncated: false, unsent: {}, convertedToQuarantine: 0 },
  };
}

interface World {
  clock: ReturnType<typeof createManualClock>;
  timers: ManualTimers;
  reconciler: Reconciler;
  decides: number;
  errors: ReconcilerErrorCode[];
  /** Every finished flow, as the reconciler reported it: a flow that was skipped counts. */
  outcomes: ReconcileOutcome[];
  answers: (ReconcileResult | Error | (() => Promise<ReconcileResult>))[];
}

function createWorld(options: { timers?: TimerPort; fallbackIntervalMs?: number; random?: () => number; executes?: ExecuteResult[] } = {}): World {
  const clock = createManualClock(NOW);
  const timers = createManualTimers();
  const world: World = { clock, timers, decides: 0, errors: [], outcomes: [], answers: [], reconciler: undefined as unknown as Reconciler };
  world.reconciler = createReconciler({
    decide: async () => {
      world.decides += 1;
      const next = world.answers.shift() ?? emptyPlan();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
    execute: () => Promise.resolve({ kind: 'done', summary: { purged: 0, quarantined: 0, unquarantined: 0, deferred: 0, skippedChanged: 0, failed: 0, failures: {} } }),
    resumePurges: () => Promise.resolve({ resumed: 0, failed: 0, foreign: 0, stopped: null, failures: {} }),
    isLocked: () => false,
    network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
    clock,
    timers: options.timers ?? timers,
    random: options.random ?? (() => 1),
    ...(options.fallbackIntervalMs === undefined ? {} : { fallbackIntervalMs: options.fallbackIntervalMs }),
    onOutcome: (outcome) => world.outcomes.push(outcome),
    onError: (code) => world.errors.push(code),
  });
  return world;
}

async function run(w: World, reason: ReconcileReason): Promise<void> {
  w.reconciler.trigger(reason);
  await w.reconciler.idle();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the hold after a failure', () => {
  it('holds the automatic triggers; a manual request, an unlock and a token refresh go through it', async () => {
    for (const through of ['manual', 'unlock', 'token'] as const) {
      const w = createWorld();
      w.answers.push(FAILED);
      await run(w, 'manual');
      expect(w.decides).toBe(1);
      // Held: a refresh, a foreground and the like run nothing.
      await run(w, 'refresh');
      await run(w, 'foreground');
      expect(w.decides).toBe(1);
      // The reasons that say something changed are not held.
      await run(w, through);
      expect(w.decides).toBe(2);
    }
  });

  it('is never longer than an hour, however many failures there have been', async () => {
    const w = createWorld();
    for (let i = 0; i < 40; i += 1) {
      w.answers.push(FAILED);
      await run(w, 'manual');
    }
    const delays = w.timers.requested();
    expect(delays.length).toBeGreaterThan(30);
    expect(Math.max(...delays)).toBe(HOLD_MAX_MS);
    expect(delays.every((d) => d <= HOLD_MAX_MS)).toBe(true);
  });

  it('a server asking for a very long wait is held for an hour at most', async () => {
    const w = createWorld();
    w.answers.push({ kind: 'failed', reason: 'network', retryAfterMs: 10 ** 12 });
    await run(w, 'manual');
    expect(Math.max(...w.timers.requested())).toBe(HOLD_MAX_MS);
  });

  it('a hold that outlives anything this module sets (the clock was moved back) is over', async () => {
    const w = createWorld();
    w.answers.push(FAILED);
    await run(w, 'manual');
    await run(w, 'refresh');
    expect(w.decides).toBe(1);
    w.clock.set(NOW - 10 * 3_600_000);
    await run(w, 'refresh');
    expect(w.decides).toBe(2);
  });
});

describe('stop() is terminal', () => {
  it('a trigger after stop runs nothing, whatever the reason', async () => {
    const w = createWorld();
    w.reconciler.stop();
    for (const reason of ['manual', 'refresh', 'unlock', 'token', 'start', 'online'] as const) await run(w, reason);
    w.reconciler.onNeedsReconcile('anything');
    await w.reconciler.idle();
    // Not even a skipped flow: nothing ran at all.
    expect(w.decides).toBe(0);
    expect(w.outcomes).toEqual([]);
    expect(w.reconciler.last.status).toBe('never');
  });

  it('start after stop does nothing', async () => {
    const w = createWorld();
    w.reconciler.stop();
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.decides).toBe(0);
    expect(w.timers.pending()).toBe(0);
  });

  it('a follow-up that was queued while a flow ran is not run once stop() was called, and no timer is armed after it', async () => {
    const w = createWorld();
    let release: () => void = () => undefined;
    w.answers.push(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          release = () => resolve(emptyPlan());
        }),
    );
    w.reconciler.start();
    // Wait until the flow is inside decide.
    while (w.decides === 0) await Promise.resolve();
    w.reconciler.trigger('manual');
    w.reconciler.trigger('refresh');
    w.reconciler.stop();
    release();
    await w.reconciler.idle();
    expect(w.decides).toBe(1);
    expect(w.outcomes).toHaveLength(1);
    expect(w.timers.pending()).toBe(0);
  });

  it('control: without stop() the same two triggers make exactly one follow-up run', async () => {
    const w = createWorld();
    let release: () => void = () => undefined;
    w.answers.push(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          release = () => resolve(emptyPlan());
        }),
    );
    w.reconciler.trigger('manual');
    while (w.decides === 0) await Promise.resolve();
    w.reconciler.trigger('manual');
    w.reconciler.trigger('manual');
    release();
    await w.reconciler.idle();
    expect(w.decides).toBe(2);
    expect(w.outcomes).toHaveLength(2);
  });

  it('a failure that ends after stop() arms no timer', async () => {
    const w = createWorld();
    let release: () => void = () => undefined;
    w.answers.push(
      () =>
        new Promise<ReconcileResult>((resolve) => {
          release = () => resolve(FAILED);
        }),
    );
    w.reconciler.start();
    while (w.decides === 0) await Promise.resolve();
    w.reconciler.stop();
    release();
    await w.reconciler.idle();
    expect(w.timers.pending()).toBe(0);
  });
});

describe('the timer', () => {
  it('is never set for less than a second, however small the interval and the jitter', async () => {
    const w = createWorld({ fallbackIntervalMs: 1, random: () => 0 });
    w.reconciler.start();
    await w.reconciler.idle();
    expect(w.timers.requested().length).toBeGreaterThan(0);
    expect(Math.min(...w.timers.requested())).toBe(1000);
  });

  it('a timer that cannot be set does not reject anything: the flow ends, the failure is reported as a code, and events still run it', async () => {
    const seen: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const w = createWorld({
        timers: {
          setTimeout: () => {
            throw new Error('timer facility gone /private/path');
          },
          clearTimeout: () => undefined,
        },
      });
      w.reconciler.start();
      await w.reconciler.idle();
      // Give a rejection that nobody handles the chance to surface.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(seen).toEqual([]);
      expect(w.errors).toContain('timer_failed');
      expect(w.decides).toBe(1);
      await run(w, 'manual');
      expect(w.decides).toBe(2);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

describe('what the reconciler reports', () => {
  it('hands onError fixed codes only, never the thrown value or its text', async () => {
    const w = createWorld();
    const secret = 'token abc123 https://oi.example.test/api/inspections/secret-id /private/path';
    w.answers.push(new Error(secret));
    await run(w, 'manual');
    expect(w.errors).toEqual(['decide_threw']);
    expect(JSON.stringify(w.errors)).not.toContain('abc123');
    expect(JSON.stringify(w.reconciler.last)).not.toContain('abc123');
  });

  it('a failing resume and a failing execute are fixed codes too', async () => {
    const errors: unknown[] = [];
    const secret = new Error('token abc123 /private/path');
    const make = (overrides: Partial<Parameters<typeof createReconciler>[0]>): Reconciler =>
      createReconciler({
        decide: () => Promise.resolve({ ...emptyPlan(), purge: ['x'] }),
        execute: () => Promise.reject(secret),
        resumePurges: () => Promise.reject(secret),
        isLocked: () => false,
        network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
        clock: createManualClock(NOW),
        timers: createManualTimers(),
        random: () => 1,
        onError: (code) => errors.push(code),
        ...overrides,
      });
    const reconciler = make({});
    reconciler.trigger('manual');
    await reconciler.idle();
    expect(errors).toEqual(['resume_threw', 'execute_threw']);
    expect(JSON.stringify(errors)).not.toContain('abc123');
  });

  it('a failing onError does not change what the flow does', async () => {
    const w = createWorld();
    const throwing = createReconciler({
      decide: () => Promise.reject(new Error('x')),
      execute: () => Promise.reject(new Error('x')),
      resumePurges: () => Promise.reject(new Error('x')),
      isLocked: () => false,
      network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
      clock: w.clock,
      timers: w.timers,
      random: () => 1,
      onError: () => {
        throw new Error('reporter broke');
      },
    });
    throwing.trigger('manual');
    await throwing.idle();
    expect(throwing.last.status).toBe('error');
  });

  it('writes nothing to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    const w = createWorld();
    w.answers.push(new Error('token abc123'));
    await run(w, 'manual');
    await run(w, 'token');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
