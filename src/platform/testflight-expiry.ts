import { loadLockState } from '../offline/lock-state';
import { parseBuiltAt } from './build-info';
import type { Clock } from './clock';
import type { Db } from './db';

/** Apple stops a TestFlight build from opening this many days after it was built. */
export const TESTFLIGHT_LIFETIME_DAYS = 90;
/** The warning starts this many days before the build stops opening. */
export const TESTFLIGHT_WARN_DAYS = 14;

const DAY_MS = 86_400_000;

export interface ExpiryNotice {
  /** Epoch ms at which the build stops opening. */
  expiresAt: number;
  /** True once `expiresAt` has been reached (the app can still be running from before). */
  expired: boolean;
}

/**
 * The expiry warning of an iOS test build, or null when there is nothing to say. Pure: `now` is a parameter.
 * Only iOS builds expire this way. A build date that is missing or not a real instant, or a `now` that is not a number,
 * says nothing: the warning is advice, and a damaged input must never invent one.
 * The warning starts exactly `TESTFLIGHT_LIFETIME_DAYS - TESTFLIGHT_WARN_DAYS` days (76) after the build instant.
 */
export function testflightExpiryNotice(input: { platform: string; builtAt: string | null; now: number }): ExpiryNotice | null {
  if (input.platform !== 'ios') return null;
  const built = parseBuiltAt(input.builtAt);
  if (built === null || !Number.isFinite(input.now)) return null;
  const expiresAt = built + TESTFLIGHT_LIFETIME_DAYS * DAY_MS;
  if (input.now < expiresAt - TESTFLIGHT_WARN_DAYS * DAY_MS) return null;
  return { expiresAt, expired: input.now >= expiresAt };
}

/**
 * The later of the device clock and the latest time this device has ever evaluated (the offline lock's own reference), so
 * setting the clock back does not hide an expiry. When the stored state cannot be read the device clock stands alone.
 */
export async function anchoredNow(db: Db, clock: Clock): Promise<number> {
  const now = clock.now();
  try {
    const { maxSeenTime } = await loadLockState(db);
    return Number.isFinite(maxSeenTime) ? Math.max(now, maxSeenTime) : now;
  } catch {
    return now;
  }
}
