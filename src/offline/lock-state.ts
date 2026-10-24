import { writeDeviceState } from '../auth/server-config';
import type { Db } from '../platform/db';
import { CLOCK_SKEW_TOLERANCE_MS, evaluateLock, type LockInput, type LockReason } from './lock';

/** Longest company name the lock screen will show; the name is server-supplied text. */
export const MAX_TENANT_NAME_LENGTH = 80;

export type LockOutcome = { locked: false } | { locked: true; reason: LockReason };

const REVOKED_MARK = 'revoked';

let writeVersion = 0;

/**
 * Counts the writes that change what an evaluation would answer (a verification, a refresh, a
 * revocation). A caller reads it before and after an evaluation: if it moved, the answer was loaded
 * from state that has since changed and is stale. Each write moves it twice, once before its first
 * statement and once after its last, so an evaluation that read the state before the write cannot
 * finish unnoticed whichever side of the write it ends on.
 */
export function lockStateVersion(): number {
  return writeVersion;
}

/** A stored non-negative integer, or null. Anything else (garbage, a float, an unsafe magnitude) is not a number to us. */
function parseStoredInteger(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reads the lock inputs from `device_state`. Unreadable values never become plausible numbers:
 * a missing or unparseable verification time is null and an unparseable limit is NaN (both lock as
 * expired). An unparseable latest-time-seen is 0, which only weakens the clock defence for that one
 * damaged row; the verification time still bounds it, and the next evaluation rewrites it.
 *
 * Only `revoked` is ever stored in `locked_reason`. Expired and clock are derived on every
 * evaluation from the other keys, so they cannot go stale.
 */
export async function loadLockState(db: Db): Promise<LockInput> {
  const rows = await db.query<{ key: string; value: string }>(
    "SELECT key, value FROM device_state WHERE key IN ('last_verified_at', 'max_seen_time', 'offline_max_days', 'locked_reason')",
  );
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    lastVerifiedAt: parseStoredInteger(byKey.get('last_verified_at')),
    maxSeenTime: parseStoredInteger(byKey.get('max_seen_time')) ?? 0,
    offlineMaxDays: parseStoredInteger(byKey.get('offline_max_days')) ?? Number.NaN,
    revoked: byKey.get('locked_reason') === REVOKED_MARK,
  };
}

const RAISE_MAX_SEEN =
  `INSERT INTO device_state (key, value) VALUES ('max_seen_time', ?)
   ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`;

/** Raises the latest time seen to `now`; never lowers it. One statement, so two writers cannot undo each other. */
export async function touchMaxSeen(db: Db, now: number): Promise<void> {
  await db.run(RAISE_MAX_SEEN, [String(Math.trunc(now))]);
}

/**
 * Records one successful online verification: the sign-in just adopted, a token refresh, or a
 * session check. `offlineMaxDays` is what the server just said, or null when the caller did not
 * learn it (a refresh), which keeps the stored limit. A value that is not an integer of at least 1
 * is not stored over a good one; a server that really says 0 is stored, and locks.
 *
 * `last_verified_at` becomes `now`. `max_seen_time` normally only rises, so verifying while the device
 * clock is still behind the latest time seen does not unlock a clock lock by itself.
 *
 * The one exception is a verification the server vouches for. The offline guard exists to stop
 * OFFLINE use past the period; a successful online session confirmation already proves the server
 * accepts this device. When `serverDateMs` (the `Date` header of that very session response) is a
 * finite number within `CLOCK_SKEW_TOLERANCE_MS` of `now`, the device clock is demonstrably right,
 * so `max_seen_time` is re-anchored to `now` even if that lowers it. This is the only place it may
 * decrease. A missing, unparseable or skewed server date never re-anchors, so a wrong device clock
 * cannot poison the reference in either direction. Nothing in the local data is touched.
 *
 * This is the session-confirmed path: the session endpoint (or a sign-in for the same identity) has
 * just accepted this device, so it also clears a revocation. A refresh alone does not; see `recordRefreshed`.
 */
export async function recordVerified(db: Db, now: number, offlineMaxDays: number | null, serverDateMs: number | null = null): Promise<void> {
  const at = String(Math.trunc(now));
  const reanchor = serverDateMs !== null && Number.isFinite(serverDateMs) && Number.isFinite(now) && Math.abs(serverDateMs - now) <= CLOCK_SKEW_TOLERANCE_MS;
  writeVersion += 1;
  try {
    await db.transaction(async (tx) => {
      await writeDeviceState(tx, 'last_verified_at', at);
      if (reanchor) await writeDeviceState(tx, 'max_seen_time', at);
      else await tx.run(RAISE_MAX_SEEN, [at]);
      if (offlineMaxDays !== null && Number.isInteger(offlineMaxDays) && offlineMaxDays >= 0) {
        await writeDeviceState(tx, 'offline_max_days', String(offlineMaxDays));
      }
      await tx.run("DELETE FROM device_state WHERE key = 'locked_reason'");
    });
  } finally {
    writeVersion += 1;
  }
}

/**
 * Records a token refresh that succeeded without the session endpoint being asked. It moves
 * `last_verified_at` forward and nothing else: a revocation is never cleared by it, and the latest
 * time seen is not touched. A revoked device stays revoked until the session endpoint accepts it or
 * the same person signs in again.
 */
export async function recordRefreshed(db: Db, now: number): Promise<void> {
  writeVersion += 1;
  try {
    await writeDeviceState(db, 'last_verified_at', String(Math.trunc(now)));
  } finally {
    writeVersion += 1;
  }
}

/** The server definitively ended this device's access (see `tokens.onRevoked`). Idempotent. */
export async function setRevoked(db: Db): Promise<void> {
  writeVersion += 1;
  try {
    await writeDeviceState(db, 'locked_reason', REVOKED_MARK);
  } finally {
    writeVersion += 1;
  }
}

/** The company name shown on the revoked screen: stored text, trimmed, bounded, or null. React escapes it on render. */
export async function loadTenantName(db: Db): Promise<string | null> {
  const rows = await db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'tenant_name'");
  const trimmed = rows[0]?.value.trim() ?? '';
  if (trimmed.length === 0) return null;
  return Array.from(trimmed).slice(0, MAX_TENANT_NAME_LENGTH).join('');
}

/** Evaluates the lock at `now` and persists the new latest time seen. This is the single entry for every trigger. */
export async function evaluateAndPersist(db: Db, now: number): Promise<LockOutcome> {
  const state = await loadLockState(db);
  const evaluation = evaluateLock(state, now);
  await touchMaxSeen(db, evaluation.nextMaxSeen);
  return evaluation.reason === null ? { locked: false } : { locked: true, reason: evaluation.reason };
}
