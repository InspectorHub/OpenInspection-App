import { describe, expect, it } from 'vitest';
import { CLOCK_SKEW_TOLERANCE_MS, DAY_MS, evaluateLock, type LockInput } from './lock';

const NOW = 1_800_000_000_000;

function state(overrides: Partial<LockInput> = {}): LockInput {
  return { lastVerifiedAt: NOW - DAY_MS, maxSeenTime: NOW - 1000, offlineMaxDays: 30, revoked: false, ...overrides };
}

describe('offline period (Review Focus #2)', () => {
  it('verified 29 days ago with a 30 day limit: not locked', () => {
    expect(evaluateLock(state({ lastVerifiedAt: NOW - 29 * DAY_MS }), NOW)).toMatchObject({ locked: false, reason: null });
  });

  it('verified 31 days ago with a 30 day limit: locked as expired', () => {
    expect(evaluateLock(state({ lastVerifiedAt: NOW - 31 * DAY_MS }), NOW)).toMatchObject({ locked: true, reason: 'expired' });
  });

  it('exactly 30 days is still allowed; one millisecond more is not', () => {
    expect(evaluateLock(state({ lastVerifiedAt: NOW - 30 * DAY_MS }), NOW).locked).toBe(false);
    expect(evaluateLock(state({ lastVerifiedAt: NOW - 30 * DAY_MS - 1 }), NOW)).toMatchObject({ locked: true, reason: 'expired' });
  });

  it('the limit is the tenant limit, not a constant: 1 day', () => {
    expect(evaluateLock(state({ offlineMaxDays: 1, lastVerifiedAt: NOW - DAY_MS }), NOW).locked).toBe(false);
    expect(evaluateLock(state({ offlineMaxDays: 1, lastVerifiedAt: NOW - DAY_MS - 1 }), NOW).locked).toBe(true);
  });

  it('a very large limit never expires within a lifetime', () => {
    expect(evaluateLock(state({ offlineMaxDays: 365, lastVerifiedAt: NOW - 364 * DAY_MS }), NOW).locked).toBe(false);
    expect(evaluateLock(state({ offlineMaxDays: Number.MAX_SAFE_INTEGER, lastVerifiedAt: 0, maxSeenTime: 0 }), NOW).locked).toBe(false);
  });
});

describe('never verified or unusable limit', () => {
  it('no verification time: locked as expired', () => {
    expect(evaluateLock(state({ lastVerifiedAt: null }), NOW)).toMatchObject({ locked: true, reason: 'expired' });
  });

  it('a verification time that is not a number: locked as expired', () => {
    expect(evaluateLock(state({ lastVerifiedAt: Number.NaN }), NOW)).toMatchObject({ locked: true, reason: 'expired' });
  });

  it.each([0, -1, -30, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, 0.5])('an unusable limit %s: locked as expired, never defaulted', (days) => {
    expect(evaluateLock(state({ offlineMaxDays: days }), NOW)).toMatchObject({ locked: true, reason: 'expired' });
  });

  it('control: a usable limit with a fresh verification is not locked', () => {
    expect(evaluateLock(state({ offlineMaxDays: 1 }), NOW).locked).toBe(false);
  });
});

describe('clock rolled back (Review Focus #3)', () => {
  it('now more than 5 minutes before the latest time seen: locked as clock', () => {
    const maxSeenTime = NOW + CLOCK_SKEW_TOLERANCE_MS + 1;
    expect(evaluateLock(state({ maxSeenTime }), NOW)).toMatchObject({ locked: true, reason: 'clock' });
  });

  it('a step back of exactly 5 minutes, and of 1 minute (NTP), is not locked', () => {
    expect(evaluateLock(state({ maxSeenTime: NOW + CLOCK_SKEW_TOLERANCE_MS }), NOW).locked).toBe(false);
    expect(evaluateLock(state({ maxSeenTime: NOW + 60_000 }), NOW).locked).toBe(false);
  });

  it('winding the clock back a day to stay inside the period is caught', () => {
    const verified = NOW - 29 * DAY_MS;
    const seen = NOW + 3 * DAY_MS;
    expect(evaluateLock({ lastVerifiedAt: verified, maxSeenTime: seen, offlineMaxDays: 30, revoked: false }, NOW - 2 * DAY_MS)).toMatchObject({
      locked: true,
      reason: 'clock',
    });
  });

  it('a verification time in the future is a rolled-back clock even when max seen is stale', () => {
    expect(evaluateLock(state({ lastVerifiedAt: NOW + 10 * 60_000, maxSeenTime: 0 }), NOW)).toMatchObject({ locked: true, reason: 'clock' });
  });

  it('a "now" that is not a number is treated as a clock fault', () => {
    expect(evaluateLock(state(), Number.NaN)).toMatchObject({ locked: true, reason: 'clock', nextMaxSeen: NOW - 1000 });
  });

  it('control: time moving forward is not a clock fault', () => {
    expect(evaluateLock(state({ maxSeenTime: NOW - 10 * DAY_MS }), NOW)).toMatchObject({ locked: false, reason: null });
  });
});

describe('revoked', () => {
  it('a revoked device is locked as revoked even when the period and clock are fine', () => {
    expect(evaluateLock(state({ revoked: true }), NOW)).toMatchObject({ locked: true, reason: 'revoked' });
  });

  it('precedence: revoked beats clock beats expired', () => {
    const bad = state({ revoked: true, maxSeenTime: NOW + DAY_MS, lastVerifiedAt: NOW - 90 * DAY_MS });
    expect(evaluateLock(bad, NOW).reason).toBe('revoked');
    expect(evaluateLock({ ...bad, revoked: false }, NOW).reason).toBe('clock');
    expect(evaluateLock({ ...bad, revoked: false, maxSeenTime: NOW }, NOW).reason).toBe('expired');
  });

  it('control: not revoked and healthy is not locked', () => {
    expect(evaluateLock(state({ revoked: false }), NOW)).toMatchObject({ locked: false, reason: null });
  });
});

describe('nextMaxSeen', () => {
  it('is the larger of the stored value and now, locked or not', () => {
    expect(evaluateLock(state({ maxSeenTime: NOW - 5 }), NOW).nextMaxSeen).toBe(NOW);
    expect(evaluateLock(state({ maxSeenTime: NOW + 60_000 }), NOW).nextMaxSeen).toBe(NOW + 60_000);
    expect(evaluateLock(state({ maxSeenTime: NOW + DAY_MS }), NOW)).toMatchObject({ locked: true, nextMaxSeen: NOW + DAY_MS });
    expect(evaluateLock(state({ lastVerifiedAt: null, maxSeenTime: 5 }), NOW)).toMatchObject({ locked: true, nextMaxSeen: NOW });
    expect(evaluateLock(state({ revoked: true, maxSeenTime: 5 }), NOW)).toMatchObject({ locked: true, nextMaxSeen: NOW });
  });

  it('never moves backwards across a sequence of evaluations', () => {
    let seen = 0;
    for (const now of [100, 50, 300, 299, 301, 10]) {
      const next = evaluateLock(state({ maxSeenTime: seen, lastVerifiedAt: 0 }), now).nextMaxSeen;
      expect(next).toBeGreaterThanOrEqual(seen);
      seen = next;
    }
    expect(seen).toBe(301);
  });
});
