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
  return (await loadSnapshot(db)).input;
}

interface LockSnapshot {
  input: LockInput;
  /** The rows exactly as read, so a later read can tell whether anything moved since. */
  fingerprint: string;
}

const LOCK_ROWS_SQL = "SELECT key, value FROM device_state WHERE key IN ('last_verified_at', 'max_seen_time', 'offline_max_days', 'locked_reason')";

async function loadSnapshot(db: Db): Promise<LockSnapshot> {
  const rows = await db.query<{ key: string; value: string }>(LOCK_ROWS_SQL);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    input: {
      lastVerifiedAt: parseStoredInteger(byKey.get('last_verified_at')),
      maxSeenTime: parseStoredInteger(byKey.get('max_seen_time')) ?? 0,
      offlineMaxDays: parseStoredInteger(byKey.get('offline_max_days')) ?? Number.NaN,
      revoked: byKey.get('locked_reason') === REVOKED_MARK,
    },
    fingerprint: JSON.stringify(rows.map((r) => [r.key, r.value]).sort()),
  };
}

const RAISE_MAX_SEEN =
  `INSERT INTO device_state (key, value) VALUES ('max_seen_time', ?)
   ON CONFLICT(key) DO UPDATE SET value = CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`;

/** Raises the latest time seen to `now`; never lowers it. One statement, so two writers cannot undo each other. */
export async function touchMaxSeen(db: Db, now: number): Promise<void> {
  await db.run(RAISE_MAX_SEEN, [String(Math.trunc(now))]);
}

let lastServerTime: ServerTimeSource | null = null;

/** Which server time the last session-confirmed verification carried: the body field, the `Date` header, both or neither. */
export type ServerTimeSource = 'body' | 'header' | 'body+header' | 'none';

function describeServerTime(serverDateMs: number | null, serverNowMs: number | null): ServerTimeSource {
  if (serverNowMs !== null && serverDateMs !== null) return 'body+header';
  if (serverNowMs !== null) return 'body';
  return serverDateMs !== null ? 'header' : 'none';
}

/** Diagnostic only: what the most recent session-confirmed verification of this run carried, or null before any. */
export function lastSessionServerTime(): ServerTimeSource | null {
  return lastServerTime;
}

function serverTimeVouchesFor(now: number, serverDateMs: number | null, serverNowMs: number | null): boolean {
  if (!Number.isFinite(now)) return false;
  const present = [serverNowMs, serverDateMs].filter((value): value is number => value !== null);
  if (present.length === 0 || !present.every((value) => Number.isFinite(value) && Math.abs(value - now) <= CLOCK_SKEW_TOLERANCE_MS)) return false;
  const [first, second] = present;
  return first === undefined || second === undefined || Math.abs(first - second) <= CLOCK_SKEW_TOLERANCE_MS;
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
 * accepts this device. The server's time comes from that very response, as `serverNowMs` (a body
 * field) and/or `serverDateMs` (the `Date` header). Every one that is present must be a finite
 * number within `CLOCK_SKEW_TOLERANCE_MS` of `now`, and when both are present they must agree with
 * each other within the same tolerance; then the device clock is demonstrably right and
 * `max_seen_time` is re-anchored to `now` even if that lowers it. This is the only place it may
 * decrease. With neither present, or any one skewed, or the two disagreeing, nothing re-anchors, so a
 * wrong device clock cannot poison the reference in either direction. Nothing in the local data is touched.
 *
 * This is the session-confirmed path: the session endpoint (or a sign-in for the same identity) has
 * just accepted this device, so it also clears a revocation. A refresh alone does not; see `recordRefreshed`.
 */
export async function recordVerified(
  db: Db,
  now: number,
  offlineMaxDays: number | null,
  serverDateMs: number | null = null,
  serverNowMs: number | null = null,
): Promise<void> {
  const at = String(Math.trunc(now));
  const reanchor = serverTimeVouchesFor(now, serverDateMs, serverNowMs);
  lastServerTime = describeServerTime(serverDateMs, serverNowMs);
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
  const rows = await db.query<{ value: unknown }>("SELECT value FROM device_state WHERE key = 'tenant_name'");
  const value = rows[0]?.value;
  // A value that is not text (an adapter may hand back null or bytes) is absent, never a failure of the whole read.
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) return null;
  return Array.from(trimmed).slice(0, MAX_TENANT_NAME_LENGTH).join('');
}

/** Evaluations repeated when the rows changed between the load and the write; then the answer comes from a fresh read alone. */
const MAX_STALE_ATTEMPTS = 3;

/**
 * Evaluates the lock at `now` and persists the new latest time seen. This is the single entry for every trigger.
 *
 * The write is conditional: inside one transaction the rows are read again and the latest time seen is
 * raised only if they are exactly what the evaluation loaded. A verification that commits between the
 * load and the write (it may have lowered the latest time seen on purpose) therefore cannot be undone by
 * a stale higher value; the evaluation is repeated from the new rows instead. If the rows keep moving,
 * the answer is taken from one more read and nothing is written, and the next trigger persists.
 */
export async function evaluateAndPersist(db: Db, now: number): Promise<LockOutcome> {
  for (let attempt = 0; attempt < MAX_STALE_ATTEMPTS; attempt += 1) {
    const snapshot = await loadSnapshot(db);
    const evaluation = evaluateLock(snapshot.input, now);
    const applied = await db.transaction(async (tx) => {
      if ((await loadSnapshot(tx)).fingerprint !== snapshot.fingerprint) return false;
      await touchMaxSeen(tx, evaluation.nextMaxSeen);
      return true;
    });
    if (applied) return outcomeOf(evaluation.reason);
  }
  return outcomeOf(evaluateLock((await loadSnapshot(db)).input, now).reason);
}

function outcomeOf(reason: LockReason | null): LockOutcome {
  return reason === null ? { locked: false } : { locked: true, reason };
}
