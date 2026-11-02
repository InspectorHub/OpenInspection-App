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

describe('the command line', () => {
  it('exits 0 for a picture and 1 for an empty tile, saying what it saw', () => {
    const good = cli(join(__dirname, 'fixtures', 'thumbnail-picture.png'));
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('ok: the tile is a picture');
    const bad = cli(join(__dirname, 'fixtures', 'thumbnail-empty-tile.png'));
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('::error::the tile is not a picture');
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
