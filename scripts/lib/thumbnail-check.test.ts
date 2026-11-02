import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { judgePicture } from './thumbnail-check.mjs';

/**
 * G4 asks whether the tile of the photo is a picture. The three fixtures are real crops from emulator screenshots of this app: the fixture
 * photo as the tile shows it (168 x 173 px, with the UPLOADING badge along the bottom), the empty light tile the app shows while it has
 * nothing to draw yet, and the white tile with a small blue glyph (what the earlier, mostly white fixture photo looked like, the case the
 * photo was changed for). The checker must not depend on the crop's exact size: another emulator image gave 168 x 171.
 */
const SCRIPT = join(__dirname, 'thumbnail-check.mjs');
const fixture = (name: string): PNG => PNG.sync.read(readFileSync(join(__dirname, 'fixtures', `thumbnail-${name}.png`)));
const dir = mkdtempSync(join(tmpdir(), 'thumbnail-check-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function crop(source: PNG, width: number, height: number): PNG {
  const out = new PNG({ width, height });
  PNG.bitblt(source, out, 0, 0, width, height, 0, 0);
  return out;
}
function flat(width: number, height: number, rgb: [number, number, number]): PNG {
  const out = new PNG({ width, height });
  for (let at = 0; at < out.data.length; at += 4) { out.data[at] = rgb[0]; out.data[at + 1] = rgb[1]; out.data[at + 2] = rgb[2]; out.data[at + 3] = 255; }
  return out;
}
function save(name: string, image: PNG): string {
  const file = join(dir, name);
  writeFileSync(file, PNG.sync.write(image));
  return file;
}
const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

describe('judgePicture', () => {
  it('passes the real tile of the fixture photo, far above the thresholds', () => {
    const v = judgePicture(fixture('picture'));
    expect(v.ok).toBe(true);
    expect(v.significantColours).toBeGreaterThan(20);
    expect(v.colouredFraction).toBeGreaterThan(0.8);
  });

  it('passes the same tile cropped to the size another emulator image gave (168 x 171), and a much smaller one', () => {
    expect(judgePicture(crop(fixture('picture'), 168, 171)).ok).toBe(true);
    expect(judgePicture(crop(fixture('picture'), 168, 165)).ok).toBe(true);
    expect(judgePicture(crop(fixture('picture'), 100, 100)).ok).toBe(true);
  });

  it('rejects the empty light tile the app shows before it has a picture (a real crop), at its size and at the other one', () => {
    for (const image of [fixture('empty-tile'), crop(fixture('empty-tile'), 168, 171)]) {
      const v = judgePicture(image);
      expect(v.ok).toBe(false);
      expect(v.significantColours).toBeLessThan(4);
    }
  });

  it('rejects the white tile with a small glyph: a few coloured pixels on a flat ground are not a picture', () => {
    const v = judgePicture(fixture('glyph-tile'));
    expect(v.ok).toBe(false);
    expect(v.colouredFraction).toBeLessThan(0.1);
  });

  it.each([[[205, 205, 205]], [[255, 255, 255]], [[0, 0, 0]], [[250, 200, 20]]] as const)('rejects a flat tile of one colour %j, even a strongly coloured one', (rgb) => {
    expect(judgePicture(flat(168, 173, [...rgb] as [number, number, number])).ok).toBe(false);
  });

  it('rejects a crop that is not a tile at all (a few pixels), instead of judging nothing', () => {
    const v = judgePicture(crop(fixture('picture'), 10, 10));
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('not a tile');
  });
});

describe('judgePicture with a reference to be like', () => {
  const reference = fixture('picture');

  /** A picture that is as colourful as the photo (a gradient, a shape) but with other colours: blues and greens where the photo has purple, red and yellow. */
  function otherPicture(width: number, height: number): PNG {
    const out = new PNG({ width, height });
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = (y * width + x) * 4;
        const inside = (x - width / 2) ** 2 + (y - height / 2) ** 2 < (width / 3) ** 2;
        out.data[at] = inside ? 20 : 0;
        out.data[at + 1] = inside ? 200 : Math.round((255 * x) / width);
        out.data[at + 2] = inside ? 240 : Math.round((255 * y) / height);
        out.data[at + 3] = 255;
      }
    }
    return out;
  }

  it('the photo is like itself, and like a crop of it of another size (distance a few, the limit 60)', () => {
    expect(judgePicture(reference, reference)).toMatchObject({ ok: true, distance: 0 });
    const v = judgePicture(crop(reference, 168, 171), reference);
    expect(v.ok).toBe(true);
    expect(v.distance).toBeLessThan(10);
  });

  it('another picture that is just as colourful passes without a reference and FAILS with one (control for what --like adds)', () => {
    const other = otherPicture(168, 173);
    expect(judgePicture(other).ok).toBe(true);
    const v = judgePicture(other, reference);
    expect(v.ok).toBe(false);
    expect(v.problems.join(' ')).toContain('another picture');
    expect(v.distance).toBeGreaterThan(60);
  });

  it('a placeholder still fails with a reference, for its own reasons', () => {
    expect(judgePicture(fixture('empty-tile'), reference).ok).toBe(false);
  });
});

describe('the command line', () => {
  it('exits 0 for a picture and 1 for an empty tile, saying what it saw', () => {
    const good = cli(join(__dirname, 'fixtures', 'thumbnail-picture.png'));
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('ok: the tile is a picture');
    const bad = cli(join(__dirname, 'fixtures', 'thumbnail-empty-tile.png'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('::error::the tile is not a picture');
  });

  it('--like: the photo passes against its own reference, another coloured picture fails, and a missing or incomplete --like is refused', () => {
    const picture = join(__dirname, 'fixtures', 'thumbnail-picture.png');
    expect(cli(picture, '--like', picture).status).toBe(0);
    expect(cli('--like', picture, picture).status).toBe(0); // the order of the arguments does not matter
    const blue = new PNG({ width: 168, height: 173 });
    for (let at = 0; at < blue.data.length; at += 4) {
      const pixel = at / 4;
      blue.data[at] = 0; blue.data[at + 1] = (pixel * 7) % 256; blue.data[at + 2] = 200 + ((pixel * 3) % 56); blue.data[at + 3] = 255;
    }
    const other = save('blue.png', blue);
    const r = cli(other, '--like', picture);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('another picture');
    expect(cli(picture, '--like').status).toBe(2);
    expect(cli(picture, '--like', join(dir, 'missing.png')).status).toBe(1);
  });

  it('a file that is not a PNG, or does not exist, is exit 1 (never a pass), and no argument is a usage error (exit 2)', () => {
    const notPng = join(dir, 'not.png');
    writeFileSync(notPng, 'this is text');
    expect(cli(notPng).status).toBe(1);
    expect(cli(join(dir, 'missing.png')).status).toBe(1);
    expect(save('flat.png', flat(168, 173, [205, 205, 205])).length).toBeGreaterThan(0);
    expect(cli(join(dir, 'flat.png')).status).toBe(1);
    expect(cli().status).toBe(2);
  });
});
