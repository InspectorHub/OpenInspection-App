import { writeDeviceState } from '../auth/server-config';
import type { Db } from '../platform/db';
import { evaluateLock, type LockInput, type LockReason } from './lock';

/** Longest company name the lock screen will show; the name is server-supplied text. */
export const MAX_TENANT_NAME_LENGTH = 80;

export type LockOutcome = { locked: false } | { locked: true; reason: LockReason };

const REVOKED_MARK = 'revoked';

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
 * `last_verified_at` becomes `now`, but `max_seen_time` only ever rises. So verifying while the
 * device clock is still behind the latest time seen does NOT unlock a clock lock: `now` is still
 * more than the tolerance behind `max_seen_time`, the next evaluation says 'clock' again, and the
 * screen tells the user to correct the date and time. Online verification proves the server
 * accepts this device; it cannot prove that the local clock is right, and the clock is the
 * thing the lock is protecting.
 *
 * Verification also clears a revocation: the server has just accepted this device.
 */
export async function recordVerified(db: Db, now: number, offlineMaxDays: number | null): Promise<void> {
  const at = String(Math.trunc(now));
  await db.transaction(async (tx) => {
    await writeDeviceState(tx, 'last_verified_at', at);
    await tx.run(RAISE_MAX_SEEN, [at]);
    if (offlineMaxDays !== null && Number.isInteger(offlineMaxDays) && offlineMaxDays >= 0) {
      await writeDeviceState(tx, 'offline_max_days', String(offlineMaxDays));
    }
    await tx.run("DELETE FROM device_state WHERE key = 'locked_reason'");
  });
}

/** The server definitively ended this device's access (see `tokens.onRevoked`). Idempotent. */
export async function setRevoked(db: Db): Promise<void> {
  await writeDeviceState(db, 'locked_reason', REVOKED_MARK);
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
