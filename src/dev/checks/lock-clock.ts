import { evaluateLock } from '../../offline/lock';
import { LOCK_CHECK_INTERVAL_MS } from '../../offline/lock-monitor';
import { evaluateAndPersist, lastSessionServerTime, loadLockState } from '../../offline/lock-state';
import { fail, guarded, pass, type CheckDef, type ExtraDef } from './types';

const MINUTE_MS = 60_000;

const def = { id: 'lock-clock', title: '[diag] lock-clock: offline lock against the real device clock' };
const simulateDef = { id: 'lock-simulate', title: '[diag] lock-simulate: evaluate and persist the lock now' };

function minutes(ms: number): string {
  return String(Math.round(ms / MINUTE_MS));
}

export const lockClock: CheckDef = {
  ...def,
  hint: 'Read-only. For the manual clock test: change the emulator date, then press "Simulate: read lock now" and read the result.',
  run: (ctx) =>
    guarded(def, async () => {
      const { db, clock } = ctx.services;
      const now = clock.now();
      const state = await loadLockState(db);
      const evaluation = evaluateLock(state, now);
      const signedIn = ctx.origin !== null;
      const persisted = state.maxSeenTime > 0 && state.maxSeenTime >= now - 2 * LOCK_CHECK_INTERVAL_MS;
      const verifiedAge = state.lastVerifiedAt === null ? 'none' : minutes(now - state.lastVerifiedAt);
      const days = Number.isNaN(state.offlineMaxDays) ? 'none' : String(state.offlineMaxDays);
      const summary = [
        `now=${String(now)}`,
        `max_seen=${state.maxSeenTime > 0 ? String(state.maxSeenTime) : 'none'}`,
        `now_minus_max_seen_min=${minutes(now - state.maxSeenTime)}`,
        `last_verified_age_min=${verifiedAge}`,
        `offline_max_days=${days}`,
        `revoked=${String(state.revoked)}`,
        `read_only_result=${evaluation.reason ?? 'unlocked'}`,
        `monitor_persisted=${persisted ? 'yes' : 'no'}`,
        `server_time=${lastSessionServerTime() ?? 'unknown'}`,
        'manual=change_emulator_date_then_press_simulate',
      ].join(' ');
      if (signedIn && !persisted) return fail(def, summary);
      return pass(def, summary);
    }),
};

export const lockSimulate: ExtraDef = {
  ...simulateDef,
  parent: 'lock-clock',
  label: 'Simulate: read lock now',
  hint: 'Runs the same evaluation the lock monitor runs and stores the latest time seen. It changes max_seen_time on purpose.',
  run: (ctx) =>
    guarded(simulateDef, async () => {
      const { db, clock } = ctx.services;
      const now = clock.now();
      const outcome = await evaluateAndPersist(db, now);
      const after = await loadLockState(db);
      return pass(simulateDef, `now=${String(now)} result=${outcome.locked ? `locked_${outcome.reason}` : 'unlocked'} max_seen_after=${String(after.maxSeenTime)}`);
    }),
};
