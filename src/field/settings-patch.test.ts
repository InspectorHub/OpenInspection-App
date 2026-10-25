import { describe, expect, it } from 'vitest';
import { sanitizeSettingsPatch } from './settings-patch';

describe('settings patch', () => {
  it('drops empty strings and keeps everything else, null and false included', () => {
    expect(sanitizeSettingsPatch({ propertyAddress: '', sqft: 1200, lotSize: null, flag: false, note: 'x' })).toEqual({ sqft: 1200, lotSize: null, flag: false, note: 'x' });
  });

  it('turns a bare date into a date-time at local nine, and leaves a date-time alone', () => {
    const out = sanitizeSettingsPatch({ date: '2026-05-01' });
    expect(out.date).toBe(new Date('2026-05-01T09:00:00').toISOString());
    expect(sanitizeSettingsPatch({ date: '2026-05-01T10:00:00.000Z' }).date).toBe('2026-05-01T10:00:00.000Z');
  });

  it('a price becomes a number, and one that is not a number is dropped', () => {
    expect(sanitizeSettingsPatch({ price: '350' })).toEqual({ price: 350 });
    expect(sanitizeSettingsPatch({ price: 'abc' })).toEqual({});
  });
});
