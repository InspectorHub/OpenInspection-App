/**
 * Export orchestrator (A-2): create/reuse a job, page rows into shards, download
 * and verify media, assemble + self-check the package, then attest completion.
 * Every stage boundary persists a checkpoint so a killed app resumes from the
 * last keyset cursor. Secrets (bearer, jobToken, step-up) stay in memory in
 * `credentials`; nothing here writes them to disk or into a URL.
 */
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { Zip, ZipDeflate } from 'fflate';
import type { DataPackageHttp } from './http';
import type { DataPackageEndpoints } from './config';
import type { DataPackageStateHost, JobCheckpoint } from './state';
import type { RowsDeps } from './rows';
import { listAllMedia, downloadMedia, type MediaDeps, type BinaryResponse } from './media';
import { assemble } from './assemble';
import type { ExportFs, ExportCredentials, TableDescriptor, ProgressFn, ExcludedItem } from './types';

export interface ExportRunnerDeps {
  readonly http: DataPackageHttp;
  readonly endpoints: DataPackageEndpoints;
  readonly credentials: ExportCredentials;
  readonly state: DataPackageStateHost;
  readonly files: ExportFs;
  readonly baseDir: string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** Binary-safe GET for media objects (no UTF-8 decode, bounded bytes). */
  readonly binaryGet: (req: { url: string; headers: Record<string, string>; maxBytes: number }) => Promise<BinaryResponse>;
}

export interface StartExportOptions {
  readonly deviceLabel: string;
  readonly clientKind: string;
  readonly stepUpToken: string;
  /** Engine origin host, used as manifest.sourceHost (never a secret). */
  readonly originHost: string;
  readonly onProgress?: ProgressFn;
}

export interface ExportResult {
  readonly jobId: string;
  readonly packageId: string;
  readonly outputDir: string;
  readonly rows: number;
  readonly media: number;
  readonly bytes: number;
  readonly manifestSha256: string;
  readonly excluded: readonly ExcludedItem[];
  readonly selfCheck: { ok: boolean; checks: number; failures: readonly string[] };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function authHeaders(deps: ExportRunnerDeps, stepUp?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${deps.credentials.bearer}`,
    'X-Data-Job': deps.credentials.jobToken,
    ...(stepUp ? { 'X-Step-Up-Token': stepUp } : {}),
  };
}

function parseTables(json: unknown): TableDescriptor[] {
  // Accept both {data:[...]} and {data:{data:[...]}} shapes defensively.
  const list = isObject(json) && isObject(json.data) && Array.isArray(json.data.data) ? json.data.data
    : isObject(json) && Array.isArray(json.data) ? json.data : null;
  if (!Array.isArray(list)) throw new Error('tables-response');
  const out: TableDescriptor[] = [];
  for (const raw of list) {
    if (!isObject(raw) || typeof raw.table !== 'string' || !Array.isArray(raw.columns)
        || !Number.isSafeInteger(raw.maxPageRows) || !Number.isSafeInteger(raw.maxPageBytes)) throw new Error('tables-descriptor');
    out.push({
      table: raw.table, columns: (raw.columns as unknown[]).filter((c): c is string => typeof c === 'string'),
      keyset: Array.isArray(raw.keyset) ? (raw.keyset as unknown[]).filter((k): k is string => typeof k === 'string') : [],
      maxPageRows: raw.maxPageRows as number, maxPageBytes: raw.maxPageBytes as number,
    });
  }
  return out;
}

interface JobMeta { jobId: string; snapshotAt: number; schemaFingerprint: string; serverVersion: string }

async function startOrResume(deps: ExportRunnerDeps, opts: StartExportOptions, existing: JobCheckpoint | null): Promise<JobMeta> {
  if (existing && existing.kind === 'export') {
    const res = await deps.http.request({ url: deps.endpoints.resume(existing.jobId), method: 'POST', headers: authHeaders(deps) });
    if (res.status !== 200 || !isObject(res.json) || !isObject(res.json.data)) throw new Error('resume-failed');
    deps.credentials.jobToken = String((res.json.data as { jobToken?: unknown }).jobToken ?? '');
    if (!deps.credentials.jobToken) throw new Error('resume-token');
    return { jobId: existing.jobId, snapshotAt: existing.snapshotAt, schemaFingerprint: '', serverVersion: '' };
  }
  const res = await deps.http.request({
    url: deps.endpoints.jobs, method: 'POST', headers: authHeaders(deps, opts.stepUpToken),
    body: JSON.stringify({ kind: 'export', clientKind: opts.clientKind, deviceLabel: opts.deviceLabel }),
    maxBytes: 1024 * 1024,
  });
  if (res.status !== 200 || !isObject(res.json) || !isObject(res.json.data)) throw new Error('create-failed');
  const data = res.json.data as { jobId?: unknown; jobToken?: unknown; snapshotAt?: unknown; schemaFingerprint?: unknown; serverVersion?: unknown };
  if (typeof data.jobId !== 'string' || typeof data.jobToken !== 'string' || !Number.isSafeInteger(data.snapshotAt)) throw new Error('create-response');
  deps.credentials.jobToken = data.jobToken;
  return {
    jobId: data.jobId, snapshotAt: data.snapshotAt as number,
    schemaFingerprint: typeof data.schemaFingerprint === 'string' ? data.schemaFingerprint : '',
    serverVersion: typeof data.serverVersion === 'string' ? data.serverVersion : '',
  };
}

/** Run the whole export. The caller owns power-save and UI lifecycle. */
export async function runExport(deps: ExportRunnerDeps, opts: StartExportOptions): Promise<ExportResult> {
  const existing = await deps.state.load();
  const { jobId, snapshotAt, schemaFingerprint, serverVersion } = await startOrResume(deps, opts, existing);
  // The package id is minted when the (first complete) manifest is assembled,
  // after the resume point — so a killed export that never reached finish has
  // no delivered manifest to stay consistent with. It is never stored in the
  // checkpoint (which is strict and secret-free).
  const packageId = randomUUID();
  const packageDir = join(deps.baseDir, jobId);

  const resumed = existing && existing.jobId === jobId;
  let checkpoint: JobCheckpoint = resumed ? existing! : {
    jobId, kind: 'export', deviceLabel: opts.deviceLabel, snapshotAt,
    stage: 'rows', tables: {}, counts: { rows: 0, media: 0 }, bytes: 0,
    meta: { schemaFingerprint, serverVersion }, updatedAt: deps.now(),
  };
  // On resume, engine metadata comes from the persisted checkpoint (the resume
  // endpoint does not return it), keeping the manifest consistent across restarts.
  const meta = resumed ? checkpoint.meta : { schemaFingerprint, serverVersion };

  // Tables.
  const tablesRes = await deps.http.request({ url: deps.endpoints.tables(jobId), method: 'GET', headers: authHeaders(deps) });
  if (tablesRes.status !== 200) throw new Error('tables-status');
  const tables = parseTables(tablesRes.json);

  const rowsDeps: RowsDeps = {
    http: (req) => deps.http.request(req),
    files: deps.files,
    credentials: deps.credentials,
    rowsUrl: (table, after, limit) => {
      const u = new URL(deps.endpoints.rows(jobId, table));
      if (after !== null) u.searchParams.set('after', after);
      u.searchParams.set('limit', String(limit));
      return u.toString();
    },
    headers: () => authHeaders(deps),
    log: deps.log,
  };

  // Table-level resume: a table with a non-null cursor was interrupted mid-read
  // (its shards were never published), so re-read it from the start. A table
  // with shards recorded was completed: reuse the bytes already on disk.
  const { readTable } = await import('./rows');
  const completedFiles: { table: string; files: readonly import('./types').WrittenFile[] }[] = [];
  for (const table of tables) {
    const done = checkpoint.tables[table.table];
    if (done && done.cursor === null && done.shards.length > 0) {
      const files: import('./types').WrittenFile[] = [];
      for (let s = 0; s < done.shards.length; s++) {
        const shard = done.shards[s]!;
        files.push({ path: shard, bytes: await deps.files.readFile(join(packageDir, shard)), rows: done.shardRows[s] ?? 0 });
      }
      completedFiles.push({ table: table.table, files });
      continue;
    }
    const result = await readTable(rowsDeps, table, null, (rows, bytes) => {
      opts.onProgress?.({ stage: 'rows', table: table.table, rows: rows, media: 0, bytes: bytes, totalTables: tables.length, doneTables: completedFiles.length });
    });
    // Publish this table's shards to disk and record them for a future resume.
    const paths: string[] = [];
    for (const f of result.files) {
      const path = f.path;
      const target = join(packageDir, path);
      // Shard paths contain subdirectories (data/...); create the parent before
      // writing — the real fs writeFile does not create parent directories.
      await deps.files.mkdir(dirname(target), { recursive: true });
      await deps.files.writeFile(target, f.bytes, { mode: 0o600 });
      paths.push(path);
    }
    completedFiles.push({ table: table.table, files: result.files });
    const tablesSoFar = { ...checkpoint.tables, [table.table]: {
      cursor: result.cursor, rows: result.rows, bytes: result.bytes,
      shards: paths, shardRows: result.files.map((f) => f.rows ?? 0),
    } };
    checkpoint = {
      ...checkpoint,
      tables: tablesSoFar,
      counts: { ...checkpoint.counts, rows: Object.values(tablesSoFar).reduce((n, t) => n + t.rows, 0) },
      bytes: Object.values(tablesSoFar).reduce((n, t) => n + t.bytes, 0),
    };
    // Checkpoint after EACH table so a kill loses at most one table's work.
    await deps.state.save(checkpoint);
    // Renew the short-lived job token between tables so a multi-hour export
    // does not 401 on the next page read.
    const beat = await deps.http.request({ url: deps.endpoints.heartbeat(jobId), method: 'POST', headers: authHeaders(deps) });
    if (beat.status === 200 && isObject(beat.json) && isObject(beat.json.data)) {
      const refreshed = (beat.json.data as { jobToken?: unknown }).jobToken;
      if (typeof refreshed === 'string' && refreshed.length > 0) deps.credentials.jobToken = refreshed;
    }
  }
  const rowResult = {
    tables: completedFiles.map((c) => ({ table: c.table, cursor: null, rows: c.files.reduce((n, f) => n + (f.rows ?? 0), 0), bytes: c.files.reduce((n, f) => n + f.bytes.length, 0), files: c.files })),
    totalRows: completedFiles.reduce((n, c) => n + c.files.reduce((m, f) => m + (f.rows ?? 0), 0), 0),
    totalBytes: completedFiles.reduce((n, c) => n + c.files.reduce((m, f) => m + f.bytes.length, 0), 0),
  };
  checkpoint = { ...checkpoint, stage: 'media' };
  await deps.state.save(checkpoint);

  // Media.
  const mediaDeps: MediaDeps = {
    json: (req) => deps.http.request({ ...req, method: 'GET' }),
    bytes: (req) => deps.binaryGet(req),
    mediaUrl: (cursor, limit) => {
      const u = new URL(deps.endpoints.media(jobId));
      if (cursor !== null) u.searchParams.set('cursor', cursor);
      u.searchParams.set('limit', String(limit));
      return u.toString();
    },
    objectUrl: (key) => deps.endpoints.mediaObject(jobId, key),
    headers: () => authHeaders(deps),
    log: deps.log,
  };
  const descriptors = await listAllMedia(mediaDeps);
  const mediaResult = await downloadMedia(mediaDeps, descriptors, opts.onProgress);
  checkpoint = { ...checkpoint, counts: { ...checkpoint.counts, media: mediaResult.rows.length }, stage: 'finish' };
  await deps.state.save(checkpoint);

  // Assemble + self-check.
  const combinedExcluded: ExcludedItem[] = [...mediaResult.excluded];
  const fingerprint = /^[0-9a-f]{64}$/.test(meta.schemaFingerprint) ? meta.schemaFingerprint : '0'.repeat(64);
  const version = /^[A-Za-z0-9_.+-]{1,64}$/.test(meta.serverVersion) ? meta.serverVersion : '0.0.0';
  const assembled = await assemble({
    packageId, schemaVersion: version, columnFingerprint: fingerprint,
    engineVersion: version, exportedAt: new Date(deps.now()).toISOString(),
    sourceMode: 'standalone', sourceTenantId: 'desktop', sourceHost: opts.originHost,
    counts: { ...Object.fromEntries(rowResult.tables.map((t) => [t.table, t.rows])) },
    dataFiles: rowResult.tables.flatMap((t) => t.files),
    mediaRows: mediaResult.rows, mediaVolumes: mediaResult.files, excluded: combinedExcluded,
  });
  if (!assembled.selfCheck.ok) throw new Error(`self-check failed: ${assembled.selfCheck.failures.join('; ')}`);
  opts.onProgress?.({ stage: 'verifying', rows: rowResult.totalRows, media: mediaResult.rows.length, bytes: rowResult.totalBytes, totalTables: tables.length, doneTables: tables.length });

  // The root volume is a single package.zip containing the data shards, media
  // index, manifest and checksums. Media volumes are separate stored zips. A
  // top-level manifest.json copy is also written so the offline verifier can
  // read the package without opening the root zip first.
  // Refuse before classic-zip limits rather than emitting a package the importer
  // cannot read (ZIP64 is out of scope for v1).
  const { ZIP_MAX_BYTES, ZIP_MAX_ENTRIES } = await import('@inspectorhub/data-package');
  if (assembled.rootFiles.length + 1 > ZIP_MAX_ENTRIES
      || assembled.rootFiles.reduce((n, f) => n + f.bytes.length, 0) > ZIP_MAX_BYTES) {
    throw new Error('root-volume-zip-limit');
  }
  const rootZip: import('./types').WrittenFile = {
    path: 'package.zip', bytes: await buildRootZip(assembled.rootFiles),
  };
  const manifestCopy = assembled.rootFiles.find((f) => f.path === 'manifest.json')!;
  const diskFiles: import('./types').WrittenFile[] = [
    rootZip, manifestCopy, ...assembled.mediaVolumes,
  ];
  await deps.files.mkdir(packageDir, { recursive: true });
  for (const f of diskFiles) {
    const final = join(packageDir, f.path);
    await deps.files.mkdir(dirname(final), { recursive: true });
    const part = `${final}.${process.pid}.part`;
    await deps.files.writeFile(part, f.bytes, { mode: 0o600 });
    await deps.files.rename(part, final);
    // Post-write self-check: read the bytes back from disk and compare with
    // what we intended to write, so a short/corrupt write fails the export.
    const readBack = await deps.files.readFile(final);
    if (readBack.length !== f.bytes.length || !readBack.every((b, i) => b === f.bytes[i])) {
      throw new Error(`write-verification-failed:${f.path}`);
    }
  }

  // Attest completion.
  const manifestSha = await (await import('@inspectorhub/data-package')).sha256Hex(
    assembled.rootFiles.find((f) => f.path === 'manifest.json')!.bytes,
  );
  const complete = await deps.http.request({
    url: deps.endpoints.complete(jobId), method: 'POST', headers: authHeaders(deps),
    body: JSON.stringify({
      counts: JSON.stringify(Object.fromEntries(rowResult.tables.map((t) => [t.table, t.rows]))),
      bytes: rowResult.totalBytes + mediaResult.files.reduce((n, f) => n + f.bytes.length, 0),
      sha256: manifestSha,
    }),
  });
  if (complete.status !== 200) throw new Error('complete-failed');
  await deps.state.clear();

  return {
    jobId, packageId, outputDir: packageDir, rows: rowResult.totalRows, media: mediaResult.rows.length,
    bytes: rowResult.totalBytes + mediaResult.files.reduce((n, f) => n + f.bytes.length, 0),
    manifestSha256: manifestSha, excluded: combinedExcluded, selfCheck: assembled.selfCheck,
  };
}

/** Build the root package.zip: data shards and text entries deflated, original paths preserved. */
function buildRootZip(files: readonly import('./types').WrittenFile[]): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const zip = new Zip((err, data, final) => {
      if (err) { reject(err); return; }
      chunks.push(data);
      size += data.length;
      if (final) {
        const out = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        resolve(out);
      }
    });
    for (const f of files) {
      const entry = new ZipDeflate(f.path);
      zip.add(entry);
      entry.push(f.bytes, true);
    }
    zip.end();
  });
}
