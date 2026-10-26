import { describe, expect, it } from 'vitest';
import { at, NOW } from '../test-support/worklist-world';
import { GROUP_ORDER, groupOf, updatedLabel, whenLabel } from './format';

describe('groupOf', () => {
  it('sorts by the device calendar day', () => {
    expect(groupOf(at(0, 8), NOW)).toBe('today');
    expect(groupOf(at(0, 23), NOW)).toBe('today');
    expect(groupOf(at(1, 0), NOW)).toBe('tomorrow');
    expect(groupOf(at(2, 9), NOW)).toBe('later');
    expect(groupOf(at(30, 9), NOW)).toBe('later');
    expect(groupOf(at(-1, 9), NOW)).toBe('earlier');
    expect(groupOf(null, NOW)).toBe('unscheduled');
  });

  it('lists the groups in the order a person works through them', () => {
    expect(GROUP_ORDER).toEqual(['today', 'tomorrow', 'later', 'earlier', 'unscheduled']);
  });
});

describe('updatedLabel', () => {
  it('says so when nothing was ever downloaded', () => {
    expect(updatedLabel(null, NOW, 'en-US')).toBe('Not updated yet');
  });

  it('is relative, in the given locale, and never a raw timestamp', () => {
    const label = updatedLabel(NOW - 5 * 60_000, NOW, 'en-US');
    expect(label).toBe('Updated 5 minutes ago');
    expect(label).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:/);
    expect(updatedLabel(NOW - 3 * 3_600_000, NOW, 'en-US')).toBe('Updated 3 hours ago');
    expect(updatedLabel(NOW - 2 * 86_400_000, NOW, 'en-US')).toBe('Updated 2 days ago');
    expect(updatedLabel(NOW - 5 * 60_000, NOW, 'de-DE')).toContain('Minuten');
  });

  it('treats a time in the future (a clock that moved) as just now', () => {
    expect(updatedLabel(NOW + 3_600_000, NOW, 'en-US')).toBe('Updated this minute');
  });
});

describe('whenLabel', () => {
  it('shows a time for today and tomorrow, a date and time otherwise, and nothing when unscheduled', () => {
    expect(whenLabel(at(0, 15), 'today', 'en-US')).toMatch(/3:00\s?PM/);
    expect(whenLabel(at(5, 15), 'later', 'en-US')).toMatch(/Oct|Nov/);
    expect(whenLabel(null, 'unscheduled', 'en-US')).toBeNull();
  });
});
