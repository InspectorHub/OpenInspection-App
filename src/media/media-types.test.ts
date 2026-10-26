import { describe, expect, it } from 'vitest';
import { DECODE_TIMEOUT_MS, HEIF_BRANDS, MAX_DECODE_INPUT_BYTES, MAX_DECODE_PIXELS, sniffMediaKind } from './media-types';

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** An ISO base media `ftyp` box: size, `ftyp`, the major brand, a minor version, then the compatible brands. */
function ftyp(major: string, compatible: string[] = []): Uint8Array {
  const size = 16 + compatible.length * 4;
  return Uint8Array.from([0, 0, 0, size, ...ascii('ftyp'), ...ascii(major), 0, 0, 0, 0, ...compatible.flatMap(ascii)]);
}

describe('sniffMediaKind', () => {
  it('recognises JPEG and PNG by their signatures', () => {
    expect(sniffMediaKind(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe('jpeg');
    expect(sniffMediaKind(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))).toBe('png');
  });

  it.each(HEIF_BRANDS)('recognises the HEIF major brand %s', (brand) => {
    expect(sniffMediaKind(ftyp(brand))).toBe('heic');
  });

  it('lists exactly the ten HEIF brands (control for the table above)', () => {
    expect([...HEIF_BRANDS].sort()).toEqual(['heic', 'heim', 'heis', 'heix', 'hevc', 'hevm', 'hevs', 'hevx', 'mif1', 'msf1']);
  });

  it('reads a compatible brand when the major brand is unknown', () => {
    expect(sniffMediaKind(ftyp('isom', ['iso2', 'heic']))).toBe('heic');
    expect(sniffMediaKind(ftyp('isom', ['iso2', 'mp41']))).toBeNull();
  });

  it('rejects an avif brand, which the renderer decodes itself, even with mif1 among the compatible brands', () => {
    expect(sniffMediaKind(ftyp('avif'))).toBeNull();
    expect(sniffMediaKind(ftyp('avif', ['mif1', 'miaf']))).toBeNull();
  });

  it('rejects a buffer shorter than 12 bytes and other file types', () => {
    expect(sniffMediaKind(Uint8Array.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(sniffMediaKind(ftyp('heic').subarray(0, 11))).toBeNull();
    expect(sniffMediaKind(Uint8Array.from(ascii('GIF89a......')))).toBeNull();
    expect(sniffMediaKind(Uint8Array.from(ascii('hello world, this is text')))).toBeNull();
  });

  it('does not read compatible brands past the end of the box', () => {
    const bytes = ftyp('isom', ['iso2']);
    const withTrailer = Uint8Array.from([...bytes, ...ascii('heic')]);
    expect(sniffMediaKind(withTrailer)).toBeNull();
  });
});

describe('decode limits', () => {
  it('are the figures the desktop decode guard is specified with', () => {
    expect(MAX_DECODE_INPUT_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_DECODE_PIXELS).toBe(64_000_000);
    expect(DECODE_TIMEOUT_MS).toBe(30_000);
  });
});
