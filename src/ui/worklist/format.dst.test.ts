import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { groupOf } from './format';

/**
 * The work list groups an inspection as today, tomorrow or later by the device's calendar day, never by "24 hours later": on the two
 * days a year the clock changes the day is 25 or 23 hours long, so counting hours puts a late-evening inspection in the wrong group.
 * The device zone is set to New York for these cases and put back afterwards.
 */
let before: string | undefined;
beforeAll(() => {
  before = process.env.TZ;
  process.env.TZ = 'America/New_York';
  // The zone must really have changed, or every case below would pass or fail for the wrong reason.
  expect(new Date(Date.UTC(2026, 6, 1, 12)).getTimezoneOffset()).toBe(240);
  expect(new Date(Date.UTC(2026, 11, 1, 12)).getTimezoneOffset()).toBe(300);
});
afterAll(() => {
  if (before === undefined) delete process.env.TZ;
  else process.env.TZ = before;
});

describe('groupOf across the days the clock changes', () => {
  it('the autumn day (25 hours): 23:30 the same evening is still today, although it is more than 24 hours after 00:10', () => {
    const now = Date.UTC(2026, 10, 1, 4, 10); // 00:10 EDT, 1 November
    const evening = Date.UTC(2026, 10, 2, 4, 30); // 23:30 EST, 1 November: 24 h 20 min later by the clock
    expect(evening - now).toBeGreaterThan(24 * 3_600_000);
    expect(groupOf(evening, now)).toBe('today');
  });

  it('the autumn day: just after midnight is tomorrow', () => {
    expect(groupOf(Date.UTC(2026, 10, 2, 5, 15), Date.UTC(2026, 10, 1, 4, 30))).toBe('tomorrow'); // 00:15 EST on the 2nd vs 00:30 EDT on the 1st
  });

  it('the spring day (23 hours): 00:10 the next day is tomorrow, although it is less than 24 hours after 00:30', () => {
    const now = Date.UTC(2027, 2, 14, 5, 30); // 00:30 EST, 14 March
    const next = Date.UTC(2027, 2, 15, 4, 10); // 00:10 EDT, 15 March: 22 h 40 min later by the clock
    expect(next - now).toBeLessThan(24 * 3_600_000);
    expect(groupOf(next, now)).toBe('tomorrow');
  });

  it('the spring day: 23:30 the same evening is today', () => {
    expect(groupOf(Date.UTC(2027, 2, 15, 3, 30), Date.UTC(2027, 2, 14, 5, 30))).toBe('today'); // 23:30 EDT on the 14th
  });

  it('control: an ordinary day behaves the same way', () => {
    expect(groupOf(Date.UTC(2026, 5, 2, 3, 30), Date.UTC(2026, 5, 1, 4, 10))).toBe('today'); // 23:30 EDT vs 00:10 EDT
    expect(groupOf(Date.UTC(2026, 5, 2, 4, 10), Date.UTC(2026, 5, 1, 4, 10))).toBe('tomorrow');
  });
});
