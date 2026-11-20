import { expect, test } from '@playwright/test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import {
  FORMAT_VERSION, ROOT_VOLUME_NAME, dataFileName, generateChecksums,
  serializeManifest, sha256Hex, type ChecksumEntry, type Manifest,
} from '@inspectorhub/data-package';
import { prepareDesktopRenderer, startDesktopHarness, type DesktopHarness } from './fixtures/desktop-harness';

/** Build a small, self-consistent package on disk for the import walkthrough. */
async function makePackageFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oi-dp-import-e2e-'));
  const file = join(dir, 'package.zip');
  const dataPath = dataFileName('contacts', 1);
  const dataText = '{"id":"c1","tenant_id":"src","name":"Alice"}\n';
  const dataBytes = strToU8(dataText);
  const manifest: Manifest = {
    formatVersion: FORMAT_VERSION, schemaVersion: '0013_import_id_map', columnFingerprint: 'a'.repeat(64),
    engineVersion: '2.6.0', packageId: '123e4567-e89b-12d3-a456-426614174000',
    exportedAt: '2026-01-01T00:00:00.000Z', sourceMode: 'standalone', sourceTenantId: 'src',
    sourceHost: null, encryption: null, counts: { contacts: 1 },
    media: { count: 0, index: { path: 'media/index.ndjson', bytes: 0, sha256: await sha256Hex(strToU8('')) } },
    files: [{ path: dataPath, volume: ROOT_VOLUME_NAME, rows: 1, bytes: dataBytes.length, sha256: await sha256Hex(dataBytes) }],
    volumes: [], excluded: [],
  };
  const checksums: ChecksumEntry[] = [
    { path: 'media/index.ndjson', sha256: manifest.media.index.sha256 },
    ...manifest.files.map((f) => ({ path: f.path, sha256: f.sha256 })),
  ];
  const zip = zipSync({
    'manifest.json': serializeManifest(manifest),
    'checksums.sha256': strToU8(generateChecksums(checksums)),
    'media/index.ndjson': strToU8(''),
    [dataPath]: dataBytes,
  });
  await writeFile(file, zip);
  return file;
}

test.describe('data-package import from the desktop window', () => {
  let desktop: DesktopHarness | undefined;
  let packageDir: string | undefined;
  test.beforeAll(prepareDesktopRenderer);
  test.afterAll(async () => {
    await desktop?.dispose();
    if (packageDir) await rm(packageDir, { recursive: true, force: true });
  });

  test('step-up, watch progress, reach completion, then confirm the irreversible revert', async () => {
    test.setTimeout(180_000);
    const packagePath = await makePackageFile();
    packageDir = packagePath.slice(0, packagePath.lastIndexOf('/'));
    desktop = await startDesktopHarness({ quitAnswer: 'quit', extraEnv: { OI_E2E_IMPORT_PACKAGE_PATH: packagePath } });
    const { page } = desktop;
    await expect(page.getByRole('heading', { name: 'Work list' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Restore a data package' }) });
    await expect(section.getByRole('button', { name: 'Choose package file' })).toBeVisible();
    await section.getByRole('button', { name: 'Choose package file' }).click();
    await section.getByRole('button', { name: 'Start import' }).click();
    await section.getByLabel(/Re-enter your password/i).fill('current-password');
    await section.getByRole('button', { name: 'Confirm' }).click();
    // The fake engine returns a small import: progress then the completion view.
    await expect(section.getByText(/Import complete/i)).toBeVisible({ timeout: 60_000 });

    // Revert is irreversible: a destructive dialog must be confirmed explicitly.
    await section.getByRole('button', { name: 'Undo import' }).click();
    await expect(page.getByText(/deletes every row and photo/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete imported data' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete imported data' }).click();
    await expect(section.getByRole('button', { name: 'Choose package file' })).toBeVisible({ timeout: 30_000 });
  });
});
