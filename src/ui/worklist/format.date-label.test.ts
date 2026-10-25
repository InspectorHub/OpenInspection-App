import { describe, expect, it } from 'vitest';
import { dateLabel } from './format';

const NOON_UTC = Date.UTC(2027, 0, 3, 12, 0, 0);

describe('dateLabel', () => {
  it('writes the device calendar date in the given language', () => {
    expect(dateLabel(NOON_UTC, 'en-US')).toBe('January 3, 2027');
  });

  it('follows the locale (control: another language writes the same day differently)', () => {
    expect(dateLabel(NOON_UTC, 'de-DE')).toBe('3. Januar 2027');
  });

  it('an unknown locale falls back to the device language instead of throwing', () => {
    expect(() => dateLabel(NOON_UTC, 'not a locale')).not.toThrow();
    expect(dateLabel(NOON_UTC, 'not a locale')).toMatch(/2027/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e16, -1e16])('a date that cannot be shown (%s) reads as unavailable', (value) => {
    expect(dateLabel(value, 'en-US')).toBe('Date unavailable');
  });
});
