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
  expect(Buffer.from(first.jpeg).includes(Buffer.from('Exif'))).toBe(false);
});
