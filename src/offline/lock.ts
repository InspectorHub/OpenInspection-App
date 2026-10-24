export const DAY_MS = 86_400_000;
/** A step back smaller than this is ordinary clock correction (NTP, a time zone change handled by the OS), not tampering. */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60 * 1000;

export type LockReason = 'expired' | 'clock' | 'revoked';

export interface LockInput {
  /** Epoch ms of the last successful online verification; null when there never was one. */
  lastVerifiedAt: number | null;
  /** The latest epoch ms this device has ever evaluated. */
  maxSeenTime: number;
  /** Days the tenant allows offline. Anything but an integer of at least 1 is unusable. */
  offlineMaxDays: number;
  revoked: boolean;
}

export interface LockEvaluation {
  locked: boolean;
  reason: LockReason | null;
  /** What to store as the new latest time seen. Never smaller than the stored value, locked or not. */
  nextMaxSeen: number;
}

function usableDays(days: number): boolean {
  return Number.isInteger(days) && days >= 1;
}

/**
 * Decides whether local data must be hidden behind the lock screen. Pure: the clock is a parameter.
 * Locking never deletes anything; it only decides what the screen offers.
 *
 * Precedence when more than one reason applies: revoked, then clock, then expired.
 * - revoked is a definitive server answer and also removes the verify and upload paths, so it must win.
 * - clock beats expired because its fix differs (correct the date and time, then verify) and a wound-back
 *   clock makes the elapsed time meaningless. Only a successful online session confirmation whose
 *   server date agrees with the device clock lowers the stored reference again (`recordVerified`); this
 *   function never does.
 *
 * Inputs that cannot be trusted lock rather than guess:
 * - no verification time (null or not a number) is 'expired': a signed-in device always has one, so its
 *   absence means the record is missing or damaged, and only an online check can restore it.
 * - an offline limit that is not an integer of at least 1 is 'expired'. The server is the source of the
 *   limit (its own minimum is 1); a default is never substituted on the device.
 * - a `now` that is not a number is 'clock'.
 *
 * The period is exceeded only when more than `offlineMaxDays` whole days have passed; exactly that long
 * is still allowed. A step back is a clock fault only when it exceeds the tolerance, measured against
 * the later of the stored latest time seen and the last verification (a verification can never lie
 * in this device's future).
 */
export function evaluateLock(state: LockInput, now: number): LockEvaluation {
  const maxSeen = Number.isFinite(state.maxSeenTime) ? state.maxSeenTime : 0;
  const nextMaxSeen = Number.isFinite(now) ? Math.max(maxSeen, now) : maxSeen;
  const verified = state.lastVerifiedAt !== null && Number.isFinite(state.lastVerifiedAt) ? state.lastVerifiedAt : null;
  const result = (reason: LockReason | null): LockEvaluation => ({ locked: reason !== null, reason, nextMaxSeen });

  if (state.revoked) return result('revoked');
  if (!Number.isFinite(now)) return result('clock');
  const reference = Math.max(maxSeen, verified ?? 0);
  if (reference - now > CLOCK_SKEW_TOLERANCE_MS) return result('clock');
  if (verified === null || !usableDays(state.offlineMaxDays)) return result('expired');
  if (now - verified > state.offlineMaxDays * DAY_MS) return result('expired');
  return result(null);
}
