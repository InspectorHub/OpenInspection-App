import { describe, expect, it } from 'vitest';
import { createManualClock } from './clock';
import { createSqlJsDb } from './db-sqljs';
import { migrate } from './schema';
import { parseBuiltAt } from './build-info';
import { anchoredNow, TESTFLIGHT_LIFETIME_DAYS, TESTFLIGHT_WARN_DAYS, testflightExpiryNotice } from './testflight-expiry';
import { touchMaxSeen } from '../offline/lock-state';

const DAY = 86_400_000;
const BUILT = '2026-10-01T12:00:00.000Z';
const BUILT_MS = Date.parse(BUILT);
const ios = (offsetMs: number, over: { platform?: string; builtAt?: string | null } = {}) =>
  testflightExpiryNotice({ platform: over.platform ?? 'ios', builtAt: over.builtAt === undefined ? BUILT : over.builtAt, now: BUILT_MS + offsetMs });

describe('the lifetime and the warning window', () => {
  it('a build lasts 90 days and warning starts 14 days before that', () => {
    expect(TESTFLIGHT_LIFETIME_DAYS).toBe(90);
    expect(TESTFLIGHT_WARN_DAYS).toBe(14);
  });
});

describe('testflightExpiryNotice boundaries (iOS)', () => {
  it('at build date + 75 days there is no warning (control: the same build warns one day later)', () => {
    expect(ios(75 * DAY)).toBeNull();
    expect(ios(76 * DAY)).not.toBeNull();
  });

  it('one millisecond before +76 days is still quiet, +76 days exactly warns', () => {
    expect(ios(76 * DAY - 1)).toBeNull();
    expect(ios(76 * DAY)).toEqual({ expiresAt: BUILT_MS + 90 * DAY, expired: false });
  });

  it('warns on the last day, and says expired from the expiry instant on', () => {
    expect(ios(90 * DAY - 1)).toEqual({ expiresAt: BUILT_MS + 90 * DAY, expired: false });
    expect(ios(90 * DAY)).toEqual({ expiresAt: BUILT_MS + 90 * DAY, expired: true });
    expect(ios(200 * DAY)?.expired).toBe(true);
  });

  it('a fresh build has nothing to say', () => {
    expect(ios(0)).toBeNull();
  });
});

describe('testflightExpiryNotice other cases', () => {
  it('never warns on Android or any other platform, even far past 90 days (control: iOS warns at the same moment)', () => {
    expect(ios(80 * DAY, { platform: 'android' })).toBeNull();
    expect(ios(500 * DAY, { platform: 'android' })).toBeNull();
    expect(ios(500 * DAY, { platform: 'windows' })).toBeNull();
    expect(ios(80 * DAY, { platform: 'ios' })).not.toBeNull();
  });

  it('without a usable build date it says nothing rather than guess', () => {
    expect(ios(80 * DAY, { builtAt: null })).toBeNull();
    expect(ios(80 * DAY, { builtAt: 'yesterday' })).toBeNull();
    expect(ios(80 * DAY, { builtAt: '' })).toBeNull();
  });

  it('a clock that cannot be read says nothing', () => {
    expect(testflightExpiryNotice({ platform: 'ios', builtAt: BUILT, now: Number.NaN })).toBeNull();
  });
});

describe('parseBuiltAt', () => {
  it('reads the ISO instant the build wrote', () => {
    expect(parseBuiltAt(BUILT)).toBe(BUILT_MS);
    expect(parseBuiltAt('2026-10-01T12:00:00Z')).toBe(BUILT_MS);
  });

  it.each(['', 'today', '2026-10-01', '2026-13-01T00:00:00.000Z', '2026-10-01T12:00:00+02:00', '2026-02-30T00:00:00.000Z'])('refuses %j', (value) => {
    expect(parseBuiltAt(value)).toBeNull();
  });

  it('refuses a value that is not text', () => {
    expect(parseBuiltAt(null)).toBeNull();
    expect(parseBuiltAt(undefined)).toBeNull();
  });
});

describe('anchoredNow: a clock set back cannot hide the expiry', () => {
  async function world() {
    const db = await createSqlJsDb();
    await migrate(db, 0);
    return { db, clock: createManualClock(BUILT_MS + 80 * DAY) };
  }

  it('uses the device clock when nothing later has been seen', async () => {
    const { db, clock } = await world();
    expect(await anchoredNow(db, clock)).toBe(BUILT_MS + 80 * DAY);
  });

  it('uses the latest time ever seen when the device clock is behind it, so the warning still shows', async () => {
    const { db, clock } = await world();
    await touchMaxSeen(db, BUILT_MS + 80 * DAY);
    clock.set(BUILT_MS + 10 * DAY);
    const now = await anchoredNow(db, clock);
    expect(now).toBe(BUILT_MS + 80 * DAY);
    expect(testflightExpiryNotice({ platform: 'ios', builtAt: BUILT, now })).not.toBeNull();
    expect(testflightExpiryNotice({ platform: 'ios', builtAt: BUILT, now: clock.now() })).toBeNull();
  });

  it('falls back to the device clock when the stored state cannot be read', async () => {
    const { db, clock } = await world();
    const broken = { ...db, query: () => Promise.reject(new Error('unreadable')) } as typeof db;
    expect(await anchoredNow(broken, clock)).toBe(clock.now());
  });
});
