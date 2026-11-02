import { parsePackage, readPackageSummary } from '@inspectorhub/offline-package';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { TITLE_MAX } from '../offline/cached-address';
import { readLabels } from '../offline/package-labels';
import { buildPackage } from './build-package';
import { collectPlan } from './collect';
import { ALICE, BOB, createExportWorld, seedInspection, type ExportWorld } from './test-support/world';
import { manifestViolations } from './test-support/engine-contract';

const IDENTITY = { tenantId: ALICE.tenantId, userId: ALICE.userId };
const BIDI = String.fromCharCode(0x202e);

async function build(world: ExportWorld): Promise<Uint8Array> {
  const plan = await collectPlan(world.db, IDENTITY, { includeQuarantined: false });
  const built = buildPackage(plan, { db: world.db, files: world.files, exportedAt: '2026-10-26T12:00:00.000Z' });
  const parts: Uint8Array[] = [];
  for await (const chunk of built.chunks) parts.push(chunk);
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

const entriesOf = (bytes: Uint8Array): Array<Record<string, unknown>> => {
  const manifest = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['manifest.json'])) as { inspections: Array<Record<string, unknown>> };
  return manifest.inspections;
};

describe('the exporter names inspections by their cached address', () => {
  it('writes the address the device has cached as an optional label beside id and reportId, and nothing else', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { address: '12 Oak Street', reportId: 'rep-1' });
    const entries = entriesOf(await build(world));
    expect(entries).toEqual([{ id: 'insp-1', reportId: 'rep-1', label: '12 Oak Street' }]);
  });

  it('omits the label for an inspection with no cached address', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { address: '12 Oak Street' });
    await seedInspection(world, 'insp-2');
    const entries = entriesOf(await build(world));
    expect(entries.find((e) => e.id === 'insp-1')).toHaveProperty('label', '12 Oak Street');
    const bare = entries.find((e) => e.id === 'insp-2');
    expect(bare).toBeDefined();
    expect(bare).not.toHaveProperty('label');
    expect(Object.keys(bare ?? {}).sort()).toEqual(['id', 'reportId']);
  });

  it('takes the address with the same cleaning and length as the work list', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { address: `${BIDI}${'z'.repeat(500)}` });
    const label = String(entriesOf(await build(world))[0]?.label);
    expect(label).not.toContain(BIDI);
    expect(Array.from(label)).toHaveLength(TITLE_MAX);
  });

  it('never reads the cache of another account', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { address: 'Alice Street' });
    await seedInspection(world, 'insp-2', { owner: BOB, address: 'Bob Street' });
    const bytes = await build(world);
    expect(JSON.stringify(entriesOf(bytes))).not.toContain('Bob Street');
  });

  it('puts nothing else about the client or the account in the manifest', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { address: '12 Oak Street' });
    const text = new TextDecoder().decode(unzipSync(await build(world))['manifest.json']);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['deviceId', 'exportedAt', 'exportedBy', 'format', 'inspections', 'tenantId', 'version']);
  });

  it('is a package the engine contract and the shared library accept, and the importer reads the label back', async () => {
    const world = await createExportWorld();
    await seedInspection(world, 'insp-1', { address: '12 Oak Street', reportId: 'rep-1' });
    await seedInspection(world, 'insp-2', { reportId: 'rep-2' });
    const bytes = await build(world);
    const manifest = JSON.parse(new TextDecoder().decode(unzipSync(bytes)['manifest.json'])) as unknown;
    expect(manifestViolations(manifest)).toEqual([]);
    expect(readPackageSummary(bytes).counts.inspections).toBe(2);
    expect(() => parsePackage(bytes)).not.toThrow();
    expect(Object.fromEntries(readLabels(bytes, ['insp-1', 'insp-2']))).toEqual({ 'insp-1': '12 Oak Street' });
  });
});
