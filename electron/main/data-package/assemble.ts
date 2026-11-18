/**
 * Assemble the final package bytes: root-volume data shards, media index,
 * manifest and checksums, then re-read them with the SAME format functions the
 * importer uses (self-check). Bytes are returned in memory here; the caller
 * writes them with atomic `.part` + rename.
 */
import {
  assertRootChecksums, compareEntryNames, DATA_PACKAGE_MEDIA_INDEX_ENTRY, FORMAT_VERSION,
  generateChecksums, MediaIndexWriter, parseChecksums, parseManifest, readNdjson, ROOT_VOLUME_NAME,
  serializeManifest, sha256Hex, verifyMediaIndex,
  type ChecksumEntry, type Manifest, type MediaIndexRow,
} from '@inspectorhub/data-package';
import type { ExcludedItem, WrittenFile } from './types';

const MAX_ROOT_BYTES = 4 * 1024 ** 3;

export interface AssembleInputs {
  readonly packageId: string;
  readonly schemaVersion: string;
  readonly columnFingerprint: string;
  readonly engineVersion: string;
  readonly exportedAt: string;
  readonly sourceMode: 'standalone' | 'saas';
  readonly sourceTenantId: string;
  readonly sourceHost: string | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly dataFiles: readonly WrittenFile[];
  readonly mediaRows: readonly MediaIndexRow[];
  readonly mediaVolumes: readonly WrittenFile[];
  readonly excluded: readonly ExcludedItem[];
}

export interface SelfCheck {
  readonly ok: boolean;
  readonly checks: number;
  readonly failures: readonly string[];
}

export interface AssembledPackage {
  readonly rootFiles: readonly WrittenFile[];
  readonly mediaVolumes: readonly WrittenFile[];
  readonly allFiles: readonly WrittenFile[];
  readonly manifest: Manifest;
  readonly selfCheck: SelfCheck;
}

async function digest(bytes: Uint8Array): Promise<string> { return sha256Hex(bytes); }

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

/** Build the media index NDJSON, ordering rows by the case-folded entry name. */
export function buildMediaIndex(rows: readonly MediaIndexRow[]): Uint8Array {
  const writer = new MediaIndexWriter();
  const ordered = rows.slice().sort((a, b) => compareEntryNames(a.entry, b.entry));
  const chunks: Uint8Array[] = [];
  for (const row of ordered) chunks.push(writer.write(row));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export async function assemble(inputs: AssembleInputs): Promise<AssembledPackage> {
  const failures: string[] = [];
  let checks = 0;
  const check = (name: string, fn: () => void): void => {
    checks++;
    try { fn(); } catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const asyncCheck = async (name: string, fn: () => Promise<void>): Promise<void> => {
    checks++;
    try { await fn(); } catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // Media index.
  const indexBytes = buildMediaIndex(inputs.mediaRows);
  const indexSha = await digest(indexBytes);

  // Manifest files: every data shard (root volume), with row/byte attestation.
  const files = inputs.dataFiles.map((f) => ({
    path: f.path, volume: ROOT_VOLUME_NAME,
    ...(f.rows !== undefined ? { rows: f.rows } : {}),
    bytes: f.bytes.length, sha256: '' as string,
  }));
  for (let i = 0; i < inputs.dataFiles.length; i++) files[i]!.sha256 = await digest(inputs.dataFiles[i]!.bytes);

  // Media volumes.
  const volumes: { name: string; bytes: number; entries: number; sha256: string }[] = [];
  for (const v of inputs.mediaVolumes) {
    volumes.push({ name: v.path, bytes: v.bytes.length, entries: 0, sha256: await digest(v.bytes) });
  }
  // Count entries per volume from the index rows (the volume files themselves
  // are stored zip volumes; entries = number of index rows targeting them).
  const entriesByVolume = new Map<string, number>();
  for (const row of inputs.mediaRows) entriesByVolume.set(row.volume, (entriesByVolume.get(row.volume) ?? 0) + 1);
  for (const v of volumes) v.entries = entriesByVolume.get(v.name) ?? 0;

  const manifest = {
    formatVersion: FORMAT_VERSION,
    schemaVersion: inputs.schemaVersion,
    columnFingerprint: inputs.columnFingerprint,
    engineVersion: inputs.engineVersion,
    packageId: inputs.packageId,
    exportedAt: inputs.exportedAt,
    sourceMode: inputs.sourceMode,
    sourceTenantId: inputs.sourceTenantId,
    sourceHost: inputs.sourceHost,
    encryption: null,
    counts: { ...inputs.counts },
    media: { count: inputs.mediaRows.length, index: { path: DATA_PACKAGE_MEDIA_INDEX_ENTRY, bytes: indexBytes.length, sha256: indexSha } },
    files,
    volumes,
    // The format schema's excluded.class is a fixed 5-value enum. A media object
    // whose bytes are not in the package (bad download or oversize) is reported
    // as `external_media` — the class that means "bytes absent, id listed".
    // Ids in the schema allow only [A-Za-z0-9_-]{1,64}; media keys with '/' are
    // reduced to a safe token so the manifest stays valid.
    excluded: inputs.excluded.map((e) => ({
      class: e.class === 'bad_media' || e.class === 'oversize_media' ? 'external_media' : e.class,
      table: e.table === 'media' ? 'inspection_media_pool' : e.table,
      reason: e.reason.slice(0, 500),
      ...(e.ids ? { ids: e.ids.map((id) => id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)).filter(Boolean).slice(0, 5000) } : {}),
      ...(e.columns ? { columns: [...e.columns].slice(0, 256) } : {}),
    })),
  } as unknown as Manifest;

  const manifestBytes = serializeManifest(manifest);
  if (manifestBytes.length > MAX_ROOT_BYTES) throw new Error('manifest-too-large');

  // checksums.sha256 lists exactly the manifest files plus the media index.
  const checksumEntries: ChecksumEntry[] = [
    ...files.map((f) => ({ path: f.path, sha256: f.sha256 })),
    { path: DATA_PACKAGE_MEDIA_INDEX_ENTRY, sha256: indexSha },
  ];
  const checksumsText = generateChecksums(checksumEntries);
  const checksumsBytes = new TextEncoder().encode(checksumsText);

  const rootFiles: WrittenFile[] = [
    ...inputs.dataFiles,
    { path: DATA_PACKAGE_MEDIA_INDEX_ENTRY, bytes: indexBytes },
    { path: 'manifest.json', bytes: manifestBytes },
    { path: 'checksums.sha256', bytes: checksumsBytes },
  ];

  // Self-check by re-reading with the importer's own functions.
  await asyncCheck('manifest canonical', async () => { parseManifest(manifestBytes); });
  check('checksums cross-reference', () => {
    const entries = parseChecksums(checksumsText);
    assertRootChecksums(entries, manifest);
  });
  for (const f of inputs.dataFiles) {
    await asyncCheck(`file ${f.path}`, async () => {
      const actual = await digest(f.bytes);
      if (actual !== files.find((x) => x.path === f.path)!.sha256) throw new Error('sha256 mismatch');
      let rows = 0;
      for await (const _ of readNdjson(bytesToStream(f.bytes))) rows++;
      if (f.rows !== undefined && rows !== f.rows) throw new Error('row count mismatch');
    });
  }
  await asyncCheck('media index', async () => {
    const count = await verifyMediaIndex(bytesToStream(indexBytes), manifest);
    if (count !== inputs.mediaRows.length) throw new Error('index row count');
  });
  for (const v of inputs.mediaVolumes) {
    await asyncCheck(`volume ${v.path}`, async () => {
      if (await digest(v.bytes) !== volumes.find((x) => x.name === v.path)!.sha256) throw new Error('volume sha256');
    });
  }

  // A run that checked nothing is a failure, never a pass.
  if (checks === 0) failures.push('no checks run');

  return {
    rootFiles,
    mediaVolumes: inputs.mediaVolumes,
    allFiles: [...rootFiles, ...inputs.mediaVolumes],
    manifest,
    selfCheck: { ok: failures.length === 0, checks, failures },
  };
}
