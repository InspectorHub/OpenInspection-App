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

  it('a price follows the engine exactly: null, true and an empty list are numbers there too', () => {
    // Mirrors the engine's sanitizeSettingsPatch, which does the same Number() conversion. Pinned so the two cannot drift apart.
    expect(sanitizeSettingsPatch({ price: null })).toEqual({ price: 0 });
    expect(sanitizeSettingsPatch({ price: true })).toEqual({ price: 1 });
    expect(sanitizeSettingsPatch({ price: [] })).toEqual({ price: 0 });
    expect(sanitizeSettingsPatch({ price: {} })).toEqual({});
  });

  it('an impossible bare date is passed on untouched, so the registry or the server refuses it instead of the conversion throwing', () => {
    expect(sanitizeSettingsPatch({ date: '2026-13-45' })).toEqual({ date: '2026-13-45' });
    expect(sanitizeSettingsPatch({ date: '2026-02-30' }).date).toBe(new Date('2026-02-30T09:00:00').toISOString());
  });

  it('an own __proto__ key is dropped and cannot become the prototype of the result', () => {
    const hostile = JSON.parse('{"__proto__":{"yearBuilt":1999},"sqft":5}') as Record<string, unknown>;
    const out = sanitizeSettingsPatch(hostile);
    expect(Object.keys(out)).toEqual(['sqft']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { yearBuilt?: unknown }).yearBuilt).toBeUndefined();
    expect(sanitizeSettingsPatch({ constructor: 'x', toString: 'y' })).toEqual({ constructor: 'x', toString: 'y' });
  });
});
