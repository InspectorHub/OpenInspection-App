import { describe, expect, it } from 'vitest';
import { assemble, buildMediaIndex, type AssembleInputs } from './assemble';
import type { MediaIndexRow, WrittenFile } from './types';
import { encodeNdjsonRow, parseChecksums, parseManifest, verifyMediaIndex } from '@inspectorhub/data-package';
import { readMediaIndex } from '@inspectorhub/data-package';

const enc = (s: string) => new TextEncoder().encode(s);

function inputs(over: Partial<AssembleInputs> = {}): AssembleInputs {
  const dataFile: WrittenFile = {
    path: 'data/inspections.ndjson', rows: 2,
    bytes: new Uint8Array([...encodeNdjsonRow({ id: 'a' }), ...encodeNdjsonRow({ id: 'b' })]),
  };
  return {
    packageId: '3f2c0a8e-1111-4222-8333-444455556666',
    schemaVersion: '0012_tenant_data_jobs',
    columnFingerprint: 'a'.repeat(64),
    engineVersion: '2.6.0',
    exportedAt: '2026-11-18T00:00:00.000Z',
    sourceMode: 'standalone',
    sourceTenantId: 'tenant-1',
    sourceHost: null,
    counts: { inspections: 2 },
    dataFiles: [dataFile],
    mediaRows: [],
    mediaVolumes: [],
    excluded: [],
    ...over,
  };
}

describe('assemble', () => {
  it('produces a canonical manifest, matching checksums and a passing self-check', async () => {
    const result = await assemble(inputs());
    expect(result.selfCheck.ok).toBe(true);
    expect(result.selfCheck.checks).toBeGreaterThan(2);
    expect(result.selfCheck.failures).toEqual([]);
    const manifest = parseManifest(result.rootFiles.find((f) => f.path === 'manifest.json')!.bytes);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.counts.inspections).toBe(2);
    const checksums = result.rootFiles.find((f) => f.path === 'checksums.sha256')!.bytes;
    const entries = parseChecksums(checksums);
    expect(entries).toHaveLength(2); // 1 data file + media index
    expect(result.allFiles.some((f) => f.path === 'data/inspections.ndjson')).toBe(true);
  });

  it('includes media index and volumes in the manifest and self-checks them', async () => {
    const row: MediaIndexRow = {
      key: 'media/a.jpg', entry: 'media/a.jpg', bytes: 3, sha256: 'b'.repeat(64),
      volume: 'media-001.zip', content_type: 'image/jpeg', referenced_by: [],
    };
    const volume: WrittenFile = { path: 'media-001.zip', bytes: enc('stored-zip-bytes') };
    const result = await assemble(inputs({
      mediaRows: [row], mediaVolumes: [volume],
      // rows count already covers media via the index; no table change needed
    }));
    const manifest = parseManifest(result.rootFiles.find((f) => f.path === 'manifest.json')!.bytes);
    expect(manifest.media.count).toBe(1);
    expect(manifest.volumes).toHaveLength(1);
    expect(manifest.volumes[0]!.entries).toBe(1);
    expect(result.allFiles.some((f) => f.path === 'media-001.zip')).toBe(true);
  });

});

describe('buildMediaIndex', () => {
  it('orders rows by entry name and produces a verifiable index', async () => {
    const mk = (key: string, entry: string): MediaIndexRow => ({
      key, entry, bytes: 1, sha256: 'c'.repeat(64), volume: 'media-001.zip',
      content_type: 'image/jpeg', referenced_by: [],
    });
    const index = buildMediaIndex([mk('z', 'media/z.jpg'), mk('a', 'media/a.jpg')]);
    const rows: MediaIndexRow[] = [];
    for await (const r of readMediaIndex(new ReadableStream({ start(c) { c.enqueue(index); c.close(); } }), { expectedRows: 2 })) rows.push(r as MediaIndexRow);
    expect(rows.map((r) => r.entry)).toEqual(['media/a.jpg', 'media/z.jpg']);
    const verified = await verifyMediaIndex(
      new ReadableStream({ start(c) { c.enqueue(index); c.close(); } }),
      { media: { count: 2, index: { bytes: index.length, sha256: await sha(index) } }, volumes: [{ name: 'media-001.zip', entries: 2, bytes: 2 }] },
    );
    expect(verified).toBe(2);
  });
});

async function sha(bytes: Uint8Array): Promise<string> {
  const { sha256Hex } = await import('@inspectorhub/data-package');
  return sha256Hex(bytes);
}
