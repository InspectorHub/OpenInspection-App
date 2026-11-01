import { expect, test } from '@playwright/test';
import { IMPORT_LIMIT_CEILINGS } from '@inspectorhub/offline-package';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePackage } from '../src/offline/test-support/import-fixtures';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

// What this proves: the bytes of an offline package leave the renderer, go through the real Electron main process
// (the https passthrough over `net.fetch`) and reach the engine unchanged, with a Content-Length, and a package near the
// compressed ceiling completes. It runs the unpackaged app, so it says nothing about the packaged CSP, fuses or installer.
// The tenant must be the fake engine's, or the screen refuses the file before anything is sent.
const TENANT = 'renderer-tenant';
const MIB = 1024 * 1024;

let desktop: DesktopHarness;
let directory: string;
test.beforeAll(prepareDesktopRenderer);
test.beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'oi-import-e2e-'));
  desktop = await startDesktopHarness();
});
test.afterEach(async () => {
  await desktop?.dispose();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function importFile(zip: Uint8Array, inspections: number): Promise<{ headline: string; elapsedMs: number }> {
  const path = join(directory, 'export.zip');
  await writeFile(path, zip);
  const { page } = desktop;
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Import package' }).click();
  await page.getByTestId('import-file-input').setInputFiles(path);
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Review and import' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(`Inspections: ${String(inspections)}`);
  const started = Date.now();
  await dialog.getByRole('button', { name: 'Import package' }).click();
  await expect(page.getByTestId('import-result')).toBeVisible({ timeout: 150_000 });
  const elapsedMs = Date.now() - started;
  return { headline: (await page.getByTestId('import-headline').innerText()).trim(), elapsedMs };
}

function expectDelivered(zip: Uint8Array): void {
  const received = desktop.engine.imports;
  expect(received, 'the engine must have recorded exactly one whole-package request').toHaveLength(1);
  const [got] = received;
  expect(got!.byteLength).toBe(zip.byteLength);
  expect(got!.contentLength).toBe(zip.byteLength);
  expect(got!.sha256).toBe(sha256(zip));
  expect(desktop.engine.errors).toEqual([]);
  // The check can fail: one flipped byte gives a different digest, so an equal digest above is not vacuous.
  const flipped = zip.slice();
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;
  expect(sha256(flipped)).not.toBe(got!.sha256);
}

test('a small package reaches the engine byte for byte and the screen reports every inspection imported', async () => {
  const { zip } = makePackage({ tenantId: TENANT, inspections: 4, photos: { 0: 2, 2: 1 }, updates: { 1: 1 } });
  const { headline, elapsedMs } = await importFile(zip, 4);
  const got = desktop.engine.imports[0];
  console.log(`IMPORT small bytes=${String(zip.byteLength)} contentLength=${String(got?.contentLength)} read=${String(got?.byteLength)} sha256=${got?.sha256 ?? ''} engineMs=${String(got?.elapsedMs)} uiMs=${String(elapsedMs)} headline=${headline}`);
  expectDelivered(zip);
  expect(headline).toBe('All 4 inspections were imported.');
});

test('a package near the compressed ceiling (about 22 MiB of incompressible bytes) uploads whole and intact', async () => {
  test.setTimeout(240_000);
  const { zip, summary } = makePackage({ tenantId: TENANT, inspections: 11, yjsBytes: 2 * MIB });
  expect(zip.byteLength).toBeGreaterThan(20 * MIB);
  expect(zip.byteLength).toBeLessThan(IMPORT_LIMIT_CEILINGS.compressedBytes);
  expect(summary.counts.inspections).toBe(11);
  const { headline, elapsedMs } = await importFile(zip, 11);
  const got = desktop.engine.imports[0];
  console.log(`IMPORT large bytes=${String(zip.byteLength)} contentLength=${String(got?.contentLength)} read=${String(got?.byteLength)} sha256=${got?.sha256 ?? ''} engineMs=${String(got?.elapsedMs)} uiMs=${String(elapsedMs)} headline=${headline}`);
  expectDelivered(zip);
  expect(headline).toBe('All 11 inspections were imported.');
});
