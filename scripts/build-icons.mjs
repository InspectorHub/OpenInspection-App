// Regenerates the app icons from branding/inspectorhub-mark.svg.
// Rasterises with the repo's Playwright Chromium at exact pixel sizes (device scale factor 1) and writes the
// .ico by hand (PNG-encoded entries). Output is deterministic for a given Chromium build: run it twice and the SHA-256 lines match.
//   node scripts/build-icons.mjs
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(join(root, 'branding', 'inspectorhub-mark.svg'), 'utf8');
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const WHITE = '#FFFFFF';
const RADIUS = 0.22; // corner radius of the white legacy launcher plate, as a fraction of its width
// The source viewBox is square and already carries its own margin, so it is scaled to the whole canvas.
const VIEWBOX = { x: 280, y: 226, size: 470 };

const out = [];
function write(rel, bytes) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  out.push(`${createHash('sha256').update(bytes).digest('hex')}  ${bytes.length.toString().padStart(7)}  ${relative(root, file).replaceAll('\\', '/')}`);
}

// Prefer the Chromium that matches the installed Playwright. If it has not been downloaded (the lockfile moved
// ahead of the local browser cache), fall back to the newest Chromium already in the Playwright cache. Pass
// OI_ICON_CHROMIUM=<path to chrome.exe> to force one.
function fallbackChromium() {
  if (process.env.OI_ICON_CHROMIUM) return process.env.OI_ICON_CHROMIUM;
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const d of dirs) for (const rel of ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
    const f = join(cache, d, rel);
    if (existsSync(f)) return f;
  }
  return undefined;
}
let browser;
try { browser = await chromium.launch(); } catch (error) {
  const executablePath = fallbackChromium();
  if (!executablePath) throw error;
  console.error(`Playwright's own Chromium is missing; using ${executablePath}`);
  browser = await chromium.launch({ executablePath });
}
const page = await browser.newPage({ deviceScaleFactor: 1 });

/**
 * canvas: pixel size of the PNG. plate: 'none' (transparent) | 'rounded' | 'circle' | 'square' (white).
 * box: width in px that the source viewBox is scaled to, centred on the canvas.
 */
async function render({ canvas, plate, box = canvas }) {
  const k = box / VIEWBOX.size;
  const tx = (canvas - box) / 2 - VIEWBOX.x * k;
  const ty = (canvas - box) / 2 - VIEWBOX.y * k;
  const plateEl = plate === 'rounded' ? `<rect width="${canvas}" height="${canvas}" rx="${canvas * RADIUS}" fill="${WHITE}"/>`
    : plate === 'circle' ? `<circle cx="${canvas / 2}" cy="${canvas / 2}" r="${canvas / 2}" fill="${WHITE}"/>`
    : plate === 'square' ? `<rect width="${canvas}" height="${canvas}" fill="${WHITE}"/>` : '';
  await page.setViewportSize({ width: canvas, height: canvas });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">${plateEl}<g transform="translate(${tx} ${ty}) scale(${k})">${inner}</g></svg>`);
  // Chromium's first raster after a page change occasionally differs by a few bytes; take shots until two agree.
  const shoot = () => page.screenshot({ type: 'png', omitBackground: plate !== 'square', clip: { x: 0, y: 0, width: canvas, height: canvas } });
  let prev = await shoot();
  for (let i = 0; i < 6; i++) {
    const next = await shoot();
    if (next.equals(prev)) return next;
    prev = next;
  }
  throw new Error(`Unstable raster at ${canvas}px (${plate})`);
}

const plated = (px) => render({ canvas: px, plate: 'none' });

// Windows: 1024 png for BrowserWindow / builder, multi-size ico for the exe.
write('electron/builder/icon.png', await plated(1024));
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const entries = [];
for (const s of icoSizes) entries.push({ s, png: await plated(s) });
const header = Buffer.alloc(6 + 16 * entries.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({ s, png }, i) => {
  const p = 6 + 16 * i;
  header[p] = s === 256 ? 0 : s; header[p + 1] = s === 256 ? 0 : s;
  header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6);
  header.writeUInt32LE(png.length, p + 8); header.writeUInt32LE(offset, p + 12);
  offset += png.length;
});
write('electron/builder/icon.ico', Buffer.concat([header, ...entries.map((e) => e.png)]));

// Android: legacy and round launcher icons sit on white (the mark is orange, so it needs an opaque plate on
// arbitrary launcher backgrounds); adaptive foreground is transparent (108dp canvas, mark inside the 66dp safe zone).
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, scale] of Object.entries(densities)) {
  const dir = `android/app/src/main/res/mipmap-${name}`;
  const px = 48 * scale;
  write(`${dir}/ic_launcher.png`, await render({ canvas: px, plate: 'rounded', box: px * 0.92 }));
  write(`${dir}/ic_launcher_round.png`, await render({ canvas: px, plate: 'circle', box: px * 0.84 }));
  // Content diagonal is about 61dp for a 56dp viewBox, inside the 66dp circle.
  write(`${dir}/ic_launcher_foreground.png`, await render({ canvas: 108 * scale, plate: 'none', box: 56 * scale }));
}

// iOS marketing icon: opaque (iOS rejects alpha), composited on white; the system applies the corner mask.
const ios = 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png';
const iosPng = await render({ canvas: 1024, plate: 'square', box: 1024 * 0.92 });
if (iosPng[25] !== 2) {
  // Chromium wrote RGBA (colour type 6); strip the alpha channel so the file has no alpha.
  throw new Error(`iOS icon has colour type ${iosPng[25]}, expected 2 (RGB)`);
}
write(ios, iosPng);

await browser.close();
console.log(out.join('\n'));
