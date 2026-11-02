import { describe, expect, it } from 'vitest';
import { addressOf, cleanLabel } from './cached-address';

const body = (propertyAddress: unknown): string => JSON.stringify({ data: { inspection: { propertyAddress } } });
const BIDI = String.fromCharCode(0x202e);
const ARABIC_LETTER_MARK = String.fromCharCode(0x061c);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const WORD_JOINER = String.fromCharCode(0x2060);
const ZERO_WIDTH_NON_JOINER = String.fromCharCode(0x200c);

describe('the address read from a cached inspection', () => {
  it('is cleaned exactly like a label read from a package, so a package and the work list never disagree', () => {
    for (const raw of ['  12 Oak\n\tStreet  ', `12${BIDI} Oak Street`, 'x'.repeat(500), `a${ARABIC_LETTER_MARK}b`, 'plain']) {
      expect(addressOf(body(raw))).toBe(cleanLabel(raw));
    }
  });

  it('collapses a newline or a tab inside the address to one space, before the length is counted', () => {
    expect(addressOf(body('12 Oak\n\n\n\n\nStreet'))).toBe('12 Oak Street');
    // 151 characters as written, 102 once the run of newlines is one space: kept whole, not cut at the length of the raw text.
    expect(addressOf(body(`${'a'.repeat(100)}${'\n'.repeat(50)}b`))).toBe(`${'a'.repeat(100)} b`);
  });

  it('is nothing for anything that is not a non-empty string address', () => {
    for (const raw of [undefined, 5, null, {}, '', '   ', BIDI, `${ARABIC_LETTER_MARK}${ZERO_WIDTH_SPACE}`]) expect(addressOf(body(raw))).toBeNull();
    expect(addressOf('not json')).toBeNull();
  });
});

describe('invisible characters in an address or a label', () => {
  it('the Arabic letter mark, the zero-width space and the word joiner are removed: they make two different rows look the same', () => {
    expect(cleanLabel(`12${ARABIC_LETTER_MARK} Oak${ZERO_WIDTH_SPACE} Str${WORD_JOINER}eet`)).toBe('12 Oak Street');
    expect(cleanLabel(`12 Oak Street${ZERO_WIDTH_SPACE}`)).toBe(cleanLabel('12 Oak Street'));
  });

  it('control: the zero-width non-joiner stays, because Persian is written with it', () => {
    const persian = `می${ZERO_WIDTH_NON_JOINER}خواهم`;
    expect(cleanLabel(persian)).toBe(persian);
  });
});
