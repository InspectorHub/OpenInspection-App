import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FORMAT_LOCALE } from '../../platform/format-locale';
import { stubDeviceLocale } from '../../test-support/default-locale';
import { at, NOW } from '../test-support/worklist-world';
import { checkedLabel, dateLabel, groupOf, updatedLabel, whenLabel } from './format';

const NOON_UTC = Date.UTC(2027, 0, 3, 12, 0, 0);
/** What a Chinese device writes for "this minute", spelt by code point so this public file stays English-only. */
const CHINESE_NOW = String.fromCodePoint(0x6b64, 0x523b);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the formatting locale is the interface language, not the device language', () => {
  it('is English until the interface is translated', () => {
    expect(FORMAT_LOCALE).toBe('en-US');
  });

  describe('on a phone set to Chinese', () => {
    beforeEach(() => {
      stubDeviceLocale('zh-CN');
    });

    it('control: the stub works (a formatter with no locale writes Chinese, one with a locale does not)', () => {
      expect(new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(0, 'minute')).toBe(CHINESE_NOW);
      expect(new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' }).format(0, 'minute')).toBe('this minute');
      expect(navigator.language).toBe('zh-CN');
    });

    it('relative times stay English', () => {
      expect(updatedLabel(NOW, NOW)).toBe('Updated this minute');
      expect(updatedLabel(NOW - 2 * 60_000, NOW)).toBe('Updated 2 minutes ago');
      expect(checkedLabel(NOW, NOW)).toBe('Checked this minute');
      expect(checkedLabel(NOW - 3 * 3_600_000, NOW)).toBe('Checked 3 hours ago');
    });

    it('calendar dates and times of day stay English', () => {
      expect(dateLabel(NOON_UTC)).toMatch(/^[A-Z][a-z]+ \d{1,2}, 2027$/);
      expect(whenLabel(at(1, 15), groupOf(at(1, 15), NOW), undefined)).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);
      const later = whenLabel(at(5, 9), 'later');
      expect(later).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [A-Z][a-z]+ \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/);
    });

    it('a locale the platform does not know falls back to the interface language, not to the device', () => {
      expect(dateLabel(NOON_UTC, 'not a locale')).toMatch(/^[A-Z][a-z]+ \d{1,2}, 2027$/);
      expect(updatedLabel(NOW, NOW, 'not a locale')).toBe('Updated this minute');
    });

    it('the time zone is still the device\'s: the day a time falls on does not change', () => {
      expect(groupOf(at(0, 23), NOW)).toBe('today');
      expect(groupOf(at(1, 0), NOW)).toBe('tomorrow');
    });
  });
});
