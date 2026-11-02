// G4: is this crop of the screen a PICTURE, or an empty tile, a placeholder or a flat colour?
//
//   node scripts/lib/thumbnail-check.mjs <png>        exits 0 for a picture, 1 for anything else, 2 for a usage error
//
// Why not compare it with a reference image: CI run 41415156795 and the one after it showed that the crop of the same tile is 168 x 173 px on
// one emulator image and 168 x 171 on another, and Maestro's assertScreenshot refuses two images of different size. What is asked here
// does not depend on the size or on exact pixels: a photo has many distinct colours and most of its pixels are saturated; a placeholder,
// an empty tile and a flat grey are a handful of near-grey colours. The badge strip along the bottom edge ("UPLOADING") and a margin
// round the tile (its border, the rounded corners) are left out.
//
// PNG decoding is pngjs (MIT, no dependencies); the counting is the only code of ours.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

/** The part of the tile that is judged, as fractions of its height and width: not the badge strip below, not the border round it. */
export const REGION = { top: 0.06, bottom: 0.7, left: 0.06, right: 0.94 };
/** Colours are counted after dropping the low 4 bits of each channel, and only those holding at least this share of the pixels count. */
export const MIN_SHARE = 0.005;
/** A pixel is "coloured" when its strongest and weakest channel differ by more than this (0 to 255). Greys and whites are below it. */
export const COLOURED_SPREAD = 40;
/** What a picture must reach. A photo of anything with colour is far above both; the tiles that are not pictures are far below. */
export const MIN_SIGNIFICANT_COLOURS = 8;
export const MIN_COLOURED_FRACTION = 0.5;

/**
 * @param {{ width: number, height: number, data: Uint8Array | Buffer }} image RGBA, as pngjs decodes it
 * @returns {{ ok: boolean, significantColours: number, colouredFraction: number, pixels: number, problems: string[] }}
 */
export function judgePicture(image) {
  const { width, height, data } = image;
  const x0 = Math.floor(width * REGION.left);
  const x1 = Math.ceil(width * REGION.right);
  const y0 = Math.floor(height * REGION.top);
  const y1 = Math.ceil(height * REGION.bottom);
  const counts = new Map();
  let pixels = 0;
  let coloured = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * width + x) * 4;
      const r = data[at] ?? 0;
      const g = data[at + 1] ?? 0;
      const b = data[at + 2] ?? 0;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (Math.max(r, g, b) - Math.min(r, g, b) > COLOURED_SPREAD) coloured += 1;
      pixels += 1;
    }
  }
  const problems = [];
  if (pixels < 400) problems.push(`only ${String(pixels)} pixels in the judged region: the crop is not a tile`);
  const significantColours = [...counts.values()].filter((count) => count >= pixels * MIN_SHARE).length;
  const colouredFraction = pixels === 0 ? 0 : coloured / pixels;
  if (significantColours < MIN_SIGNIFICANT_COLOURS) problems.push(`${String(significantColours)} distinct colours (a picture has at least ${String(MIN_SIGNIFICANT_COLOURS)})`);
  if (colouredFraction < MIN_COLOURED_FRACTION) problems.push(`${(colouredFraction * 100).toFixed(1)}% of the pixels are coloured (a picture has at least ${String(MIN_COLOURED_FRACTION * 100)}%)`);
  return { ok: problems.length === 0, significantColours, colouredFraction, pixels, problems };
}

function main(argv) {
  const [file] = argv;
  if (!file) {
    console.error('usage: thumbnail-check.mjs <png>');
    return 2;
  }
  let image;
  try {
    image = PNG.sync.read(readFileSync(file));
  } catch (error) {
    console.error(`::error::${file} cannot be read as a PNG: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const verdict = judgePicture(image);
  const line = `${String(image.width)}x${String(image.height)} px, ${String(verdict.significantColours)} significant colours, ${(verdict.colouredFraction * 100).toFixed(1)}% coloured`;
  if (verdict.ok) {
    console.log(`ok: the tile is a picture (${line})`);
    return 0;
  }
  console.error(`::error::the tile is not a picture (${line}): ${verdict.problems.join('; ')}`);
  return 1;
}

// Only when run as a script, not when a test imports judgePicture.
if (process.argv[1]?.endsWith('thumbnail-check.mjs')) process.exitCode = main(process.argv.slice(2));
