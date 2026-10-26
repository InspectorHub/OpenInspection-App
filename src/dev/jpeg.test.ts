import { describe, expect, it } from 'vitest';
import { paddedJpegBytes, tinyJpegBytes } from './jpeg';

describe('diagnostic jpeg', () => {
  it('is a small, well-formed JPEG: start marker, end marker, a frame header, under the engine ceiling', () => {
    const bytes = tinyJpegBytes();
    expect(bytes.length).toBeGreaterThan(500);
    expect(bytes.length).toBeLessThan(800);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    expect([bytes[bytes.length - 2], bytes[bytes.length - 1]]).toEqual([0xff, 0xd9]);
    expect(bytes.some((byte, index) => byte === 0xff && bytes[index + 1] === 0xc0)).toBe(true);
  });

  it('hands out a copy each time', () => {
    const first = tinyJpegBytes();
    first[0] = 0;
    expect(tinyJpegBytes()[0]).toBe(0xff);
  });

  it('pads after the end marker without touching the image', () => {
    const image = tinyJpegBytes();
    const padded = paddedJpegBytes(4096);
    expect(padded.length).toBe(4096);
    expect(Array.from(padded.subarray(0, image.length))).toEqual(Array.from(image));
    expect(padded[image.length]).toBe(0);
  });
});
