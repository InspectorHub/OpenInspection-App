import { describe, expect, it } from 'vitest';
import { at, NOW } from '../test-support/worklist-world';
import { checkedLabel, groupOf, stripBidi, updatedLabel, whenLabel } from './format';

const UNUSABLE: [string, number][] = [
  ['beyond the range of a date (1e16)', 1e16],
  ['the negative edge of the range', -1e16],
  ['not a number', Number.NaN],
  ['infinity', Number.POSITIVE_INFINITY],
];

describe('dates that cannot be shown', () => {
  it.each(UNUSABLE)('%s: never throws, sits under Not scheduled and says the date is unavailable', (_name, value) => {
    expect(() => groupOf(value, NOW)).not.toThrow();
    const group = groupOf(value, NOW);
    expect(group).toBe('unscheduled');
    expect(whenLabel(value, group, 'en-US')).toBe('Date unavailable');
  });

  it.each(UNUSABLE)('%s: a time of last update or check never throws', (_name, value) => {
    expect(() => updatedLabel(value, NOW, 'en-US')).not.toThrow();
    expect(() => checkedLabel(value, NOW, 'en-US')).not.toThrow();
  });

  it('a time that is not a number reads as unavailable, not as a made-up age', () => {
    expect(updatedLabel(Number.NaN, NOW, 'en-US')).toBe('Date unavailable');
    expect(checkedLabel(Number.NaN, NOW, 'en-US')).toBe('Date unavailable');
  });

  it('a clock that cannot be read groups nothing and throws nothing', () => {
    expect(groupOf(at(0), Number.NaN)).toBe('unscheduled');
    expect(groupOf(at(0), 1e16)).toBe('unscheduled');
  });

  it('a formatter that throws is caught', () => {
    expect(whenLabel(1e16, 'later', 'en-US')).toBe('Date unavailable');
    expect(whenLabel(Number.NaN, 'today', 'en-US')).toBe('Date unavailable');
  });

  it('control: a negative time that a date can hold (1969) is simply earlier and is formatted', () => {
    expect(groupOf(-5, NOW)).toBe('earlier');
    const label = whenLabel(-5, 'earlier', 'en-US');
    expect(label).not.toBeNull();
    expect(label).not.toBe('Date unavailable');
  });

  it('control: a usable time is formatted and a missing one has no line at all', () => {
    expect(whenLabel(at(0, 15), 'today', 'en-US')).toBe('3:00 PM');
    expect(whenLabel(null, 'unscheduled', 'en-US')).toBeNull();
  });
});

describe('stripBidi', () => {
  it('removes every direction control and mark, and nothing else', () => {
    const all = '‪‫‬‭‮⁦⁧⁨⁩‎‏';
    expect(stripBidi(`a${all}b`)).toBe('ab');
    expect(stripBidi('Zażółć café 😀 12 Elm St.')).toBe('Zażółć café 😀 12 Elm St.');
  });
});
