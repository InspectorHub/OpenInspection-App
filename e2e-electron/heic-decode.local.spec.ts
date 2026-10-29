import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge, DecodeHeicReply } from '../electron/shared/ipc-contract.ts';

let electronApp: ElectronApplication;
let page: Page;
let userData: string;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-heic-local-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.OI_USER_DATA_DIR = userData;
  env.OI_RENDERER_ROOT = 'e2e-electron/fixtures/shell-page';
  env.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  env.OI_E2E_HEIC_HELPER = resolve('dist-electron/native/win-heic-helper.exe');
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env });
  page = await electronApp.firstWindow();
  await expect(page.locator('#status')).toHaveText('Shell checks complete');
});

test.afterEach(async () => {
  await electronApp?.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function decode(file: Buffer, options: { maxLongEdge: number; keepOriginal?: { maxBytes: number } }): Promise<DecodeHeicReply> {
  return page.evaluate(async ({ encoded, maxLongEdge, keepOriginal }) => {
    const bridge = (window as unknown as { oiDesktop: DesktopBridge }).oiDesktop;
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    return bridge.media.decodeHeic({ bytes, maxLongEdge, keepOriginal });
  }, { encoded: file.toString('base64'), ...options });
}

async function dimensions(jpegBase64: string): Promise<{ width: number; height: number }> {
  return page.evaluate(async (encoded) => {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }, jpegBase64);
}

async function centerRgb(jpegBase64: string): Promise<[number, number, number]> {
  return page.evaluate(async (encoded) => {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D context is unavailable');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixel = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
    return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0] as [number, number, number];
  }, jpegBase64);
}

function jpegHasSegment(jpeg: Uint8Array, targetMarker: number): boolean {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return false;
  let offset = 2;
  while (offset + 3 < jpeg.length) {
    if (jpeg[offset] !== 0xff) return false;
    while (jpeg[offset] === 0xff) offset++;
    const marker = jpeg[offset++];
    if (marker === 0xda || marker === 0xd9) return false;
    if (marker === 0x01 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > jpeg.length) return false;
    const segmentLength = ((jpeg[offset] ?? 0) << 8) | (jpeg[offset + 1] ?? 0);
    if (segmentLength < 2 || offset + segmentLength > jpeg.length) return false;
    if (marker === targetMarker) return true;
    offset += segmentLength;
  }
  return false;
}

test('decodes a synthetic HEIC through the real Windows helper and scales without upscaling', async () => {
  const file = await readFile(resolve('src/media/heic/fixtures/fixture-64x48.heic'));
  const reply = await decode(file, { maxLongEdge: 32 });
  expect(reply.ok).toBe(true);
  if (!reply.ok) return;
  const jpeg = new Uint8Array(reply.jpeg);
  expect([...jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
  expect([...jpeg.slice(-2)]).toEqual([0xff, 0xd9]);
  expect(await dimensions(Buffer.from(reply.jpeg).toString('base64'))).toEqual({ width: 32, height: 24 });
});

test('refuses a non-HEIF image at the native helper boundary', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  await expect(decode(png, { maxLongEdge: 32 })).resolves.toEqual({ ok: false, code: 'UNSUPPORTED' });
});

test('keeps original HEIC dimensions and produces deterministic metadata-free JPEG output', async () => {
  const app1Control = Uint8Array.of(0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9);
  const app2Control = Uint8Array.of(0xff, 0xd8, 0xff, 0xe2, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9);
  expect(jpegHasSegment(app1Control, 0xe1)).toBe(true);
  expect(jpegHasSegment(app2Control, 0xe2)).toBe(true);

  const file = await readFile(resolve('src/media/heic/fixtures/fixture-64x48.heic'));
  const [first, second] = await Promise.all([
    decode(file, { maxLongEdge: Infinity, keepOriginal: { maxBytes: 10 * 1024 * 1024 } }),
    decode(file, { maxLongEdge: Infinity, keepOriginal: { maxBytes: 10 * 1024 * 1024 } }),
  ]);
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(await dimensions(Buffer.from(first.jpeg).toString('base64'))).toEqual({ width: 64, height: 48 });
  expect(createHash('sha256').update(new Uint8Array(first.jpeg)).digest('hex'))
    .toBe(createHash('sha256').update(new Uint8Array(second.jpeg)).digest('hex'));
  const jpeg = new Uint8Array(first.jpeg);
  expect(Buffer.from(jpeg).includes(Buffer.from('Exif'))).toBe(false);
  expect(jpegHasSegment(jpeg, 0xe1)).toBe(false); // EXIF and XMP metadata use APP1.
  expect(jpegHasSegment(jpeg, 0xe2)).toBe(false); // ICC profiles use APP2.
});

test('converts a Display P3 HEIC color sample to its expected sRGB values', async () => {
  const file = await readFile(resolve('src/media/heic/fixtures/fixture-p3.heic'));
  const reply = await decode(file, { maxLongEdge: 64 });
  expect(reply.ok).toBe(true);
  if (!reply.ok) return;
  const jpeg = Buffer.from(reply.jpeg);
  const actual = await centerRgb(jpeg.toString('base64'));
  const expected = [249, 61, 0];
  const encodedP3 = [230, 80, 30];
  for (const [index, channel] of actual.entries()) {
    const expectedChannel = expected[index] ?? 0;
    expect(Math.abs(channel - expectedChannel)).toBeLessThan(Math.abs((encodedP3[index] ?? 0) - expectedChannel));
    expect(Math.abs(channel - expectedChannel)).toBeLessThanOrEqual(24);
  }
  expect(jpeg.includes(Buffer.from('ICC_PROFILE'))).toBe(false);
});

test('refuses an oversized primary ispe before the codec attempts to decode it', async () => {
  const file = await readFile(resolve('src/media/heic/fixtures/fixture-bomb-ispe.heic'));
  const started = Date.now();
  await expect(decode(file, { maxLongEdge: 32 })).resolves.toEqual({ ok: false, code: 'TOO_LARGE_PIXELS' });
  expect(Date.now() - started).toBeLessThan(1_000);
});

test('classifies a truncated HEIC as corrupt at the real helper boundary', async () => {
  const file = await readFile(resolve('src/media/heic/fixtures/corrupt.heic'));
  await expect(decode(file, { maxLongEdge: 32 })).resolves.toEqual({ ok: false, code: 'CORRUPT' });
});

test('refuses keep-original output when the JPEG quality floor still exceeds maxBytes', async () => {
  const file = await readFile(resolve('src/media/heic/fixtures/fixture-64x48.heic'));
  await expect(decode(file, { maxLongEdge: Infinity, keepOriginal: { maxBytes: 1 } }))
    .resolves.toEqual({ ok: false, code: 'TOO_LARGE_PIXELS' });
});
