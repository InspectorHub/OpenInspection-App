/**
 * Import orchestrator (A-6): verify a local package, then drive the engine's
 * dumb import API — create/reuse a job, preflight, apply rows tier by tier,
 * upload media and evidence, attest completion, and (on request) revert.
 *
 * Mirrors the export runner's dedications: the main process owns the work, no
 * bytes cross IPC, secrets (bearer, jobToken, step-up) stay in memory, and every
 * authority decision is re-scoped by the engine from the job token. The client
 * only ever sends data the engine validates again.
 */
import type { DataPackageHttp } from './http';
import type { DataPackageEndpoints } from './config';
import type { DataPackageStateHost, JobCheckpoint } from './state';
import { verifyPackage, type LocalPreview, type VerifyResult } from './preflight';
import { listPackage, readPackageEntry, readPackageEntries } from './zip-reader';
import type { MediaIndexRow } from './types';
import type { ProgressFn } from './types';

export interface ImportRunnerDeps {
  readonly http: DataPackageHttp;
  readonly endpoints: DataPackageEndpoints;
  readonly bearer: string;
  readonly state: DataPackageStateHost;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  /** Read the whole package file from disk (main process only; bytes never cross IPC). */
  readonly readPackage: () => Promise<Uint8Array>;
  /** Read one media volume zip by name (separate volume files). */
  readonly readVolume: (name: string) => Promise<Uint8Array | undefined>;
  /** Mint a FRESH step-up token for the given action. Engine step-up tokens are
   *  single-use and action-bound, so every privileged call needs its own. */
  readonly stepUp: (action: 'data-export-start' | 'data-import-apply' | 'data-import-revert') => Promise<string>;
}

export interface StartImportOptions {
  readonly deviceLabel: string;
  readonly clientKind: string;
  readonly onProgress?: ProgressFn;
  /** E2E only: leave the job running (no complete/state-clear) so revert can use it. */
  readonly skipComplete?: boolean;
}

export interface ImportResult {
  readonly jobId: string;
  /** Live job token, kept in main-process memory only (never crosses IPC). */
  readonly jobToken: string;
  readonly packageId: string;
  readonly applied: Record<string, number>;
  readonly skipped: Record<string, number>;
  readonly rejected: { table: string; sourceId: string; code: string }[];
  readonly mediaUploaded: number;
  readonly archiveOk: boolean;
  readonly preview: LocalPreview;
}

export interface RevertResult {
  readonly done: boolean;
  readonly processed: number;
  readonly step: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function headers(deps: ImportRunnerDeps, jobToken: string, stepUp?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${deps.bearer}`,
    'X-Data-Job': jobToken,
    ...(stepUp ? { 'X-Step-Up-Token': stepUp } : {}),
  };
}

function dataOf(res: { status: number; json: unknown }, code: string): Record<string, unknown> {
  if ((res.status < 200 || res.status >= 300) || !isObject(res.json) || !isObject(res.json.data)) {
    throw new Error(code);
  }
  return res.json.data as Record<string, unknown>;
}

async function createOrResumeJob(
  deps: ImportRunnerDeps, opts: StartImportOptions, existing: JobCheckpoint | null, packageId: string,
): Promise<{ jobId: string; jobToken: string }> {
  if (existing && existing.kind === 'import') {
    const res = await deps.http.request({
      url: deps.endpoints.resume(existing.jobId), method: 'POST',
      headers: { Authorization: `Bearer ${deps.bearer}`, 'X-Data-Device-Label': opts.deviceLabel },
    });
    const data = dataOf(res, 'resume-failed');
    const jobToken = String(data.jobToken ?? '');
    if (!jobToken) throw new Error('resume-token');
    return { jobId: existing.jobId, jobToken };
  }
  const res = await deps.http.request({
    url: deps.endpoints.jobs, method: 'POST',
    headers: { Authorization: `Bearer ${deps.bearer}`, 'X-Step-Up-Token': await deps.stepUp('data-export-start') },
    body: JSON.stringify({ kind: 'import', clientKind: opts.clientKind, deviceLabel: opts.deviceLabel, packageId }),
  });
  const data = dataOf(res, 'create-failed');
  const jobId = String(data.jobId ?? '');
  const jobToken = String(data.jobToken ?? '');
  if (!jobId || !jobToken) throw new Error('create-response');
  return { jobId, jobToken };
}

interface Tier { readonly index: number; readonly tables: readonly string[] }
function parsePlan(data: Record<string, unknown>): Tier[] {
  const tiers = data.tiers;
  if (!Array.isArray(tiers)) throw new Error('plan-response');
  return tiers.map((tier, index) => {
    if (!Array.isArray(tier) || !tier.every((t) => typeof t === 'string')) throw new Error('plan-tier');
    return { index, tables: tier as string[] };
  });
}

/** Read a root-volume entry by name, or null if absent. Never passes -1 to the bounded reader. */
function readRootEntry(zip: Uint8Array, name: string): Uint8Array | null {
  const list = listPackage(zip);
  const size = list.ok ? list.entries.get(name) : undefined;
  return size === undefined ? null : readPackageEntry(zip, name, size);
}

/** Parse a media index NDJSON into rows (each line is a validated MediaIndexRow). */
function parseMediaIndex(bytes: Uint8Array): MediaIndexRow[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const rows: MediaIndexRow[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const parsed = JSON.parse(line) as MediaIndexRow;
    if (!isObject(parsed as object) || typeof parsed.key !== 'string' || typeof parsed.entry !== 'string'
        || typeof parsed.bytes !== 'number' || typeof parsed.sha256 !== 'string'
        || typeof parsed.volume !== 'string' || typeof parsed.content_type !== 'string') {
      throw new Error('media-index-row');
    }
    rows.push(parsed);
  }
  return rows;
}

/** The table name a data file belongs to: data/<table>.ndjson[.<shard>] . */
function tableOf(path: string): string {
  const m = /^data\/([a-z][a-z0-9_]*)\.ndjson(?:\.\d+)?$/.exec(path);
  return m?.[1] ?? path;
}

/** Run the whole import. The caller owns power-save and UI lifecycle. */
export async function runImport(deps: ImportRunnerDeps, opts: StartImportOptions): Promise<ImportResult> {
  // 1. Pre-read media volumes into a cache so the synchronous verifier and the
  //    media uploader both see the same bytes.
  const rootZip = await deps.readPackage();
  const preliminary = listPackage(rootZip);
  const volumeCache = new Map<string, Uint8Array>();
  const manifestSize = preliminary.ok ? preliminary.entries.get('manifest.json') : undefined;
  // Best-effort peek: a missing or malformed manifest is reported with a clear
  // code by verifyPackage just below, so this must never throw.
  const manifestPeek = manifestSize === undefined ? null : readPackageEntry(rootZip, 'manifest.json', manifestSize);
  if (manifestPeek) {
    try {
      const manifest = JSON.parse(new TextDecoder().decode(manifestPeek)) as { volumes?: { name: string }[] };
      for (const v of manifest.volumes ?? []) {
        if (typeof v.name !== 'string') continue;
        const bytes = await deps.readVolume(v.name);
        if (bytes) volumeCache.set(v.name, bytes);
      }
    } catch {
      // verifyPackage produces the precise error next.
    }
  }

  const verification: VerifyResult = verifyPackage(rootZip, (name) => volumeCache.get(name));
  if (!verification.ok) throw new Error(`package-invalid:${verification.problem}`);
  const preview = verification.preview;

  const existing = await deps.state.load();
  const { jobId, jobToken } = await createOrResumeJob(deps, opts, existing, preview.manifest.packageId);

  // 2. Preflight (read-only; no step-up).
  const preRes = await deps.http.request({
    url: deps.endpoints.importPreflight(jobId), method: 'POST', headers: headers(deps, jobToken),
    body: JSON.stringify({
      formatVersion: preview.manifest.formatVersion,
      columnFingerprint: preview.manifest.columnFingerprint,
      schemaVersion: preview.manifest.schemaVersion,
      sourceTenantId: preview.manifest.sourceTenantId,
      sourceMode: preview.manifest.sourceMode,
      counts: preview.counts,
    }),
  });
  const pre = dataOf(preRes, 'preflight-failed');
  if (pre.ok !== true) throw new Error(`preflight-blocked:${JSON.stringify(pre.reasons ?? [])}`);

  // 3. Apply tier by tier, parents before children (plan order) so the engine's
  //    id-map is populated before any child references its parent.
  const tiers = parsePlan(dataOf(await deps.http.request({
    url: deps.endpoints.importPlan(jobId), method: 'GET', headers: headers(deps, jobToken),
  }), 'plan-failed'));
  const applied: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const rejected: { table: string; sourceId: string; code: string }[] = [];

  const wanted = new Map(preview.manifest.files.map((f) => [f.path, f.bytes] as const));
  const rowsByTable = new Map<string, Record<string, unknown>[]>();
  for (const [path, bytes] of readPackageEntries(rootZip, wanted)) {
    if (!bytes) throw new Error(`package-entry:${path}`);
    const rows: Record<string, unknown>[] = [];
    for (const line of new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n')) {
      if (line === '') continue;
      const parsed = JSON.parse(line) as unknown;
      if (!isObject(parsed)) throw new Error('ndjson-row');
      rows.push(parsed);
    }
    const table = tableOf(path);
    rowsByTable.set(table, [...(rowsByTable.get(table) ?? []), ...rows]);
  }

  const batchRows = 1000; // engine route cap
  const totalTables = tiers.reduce((n, t) => n + t.tables.length, 0);
  let doneTables = 0;
  for (const tier of tiers) {
    for (const table of tier.tables) {
      const rows = rowsByTable.get(table) ?? [];
      for (let i = 0; i < rows.length; i += batchRows) {
        const data = dataOf(await deps.http.request({
          url: deps.endpoints.importBatches(jobId), method: 'POST', headers: headers(deps, jobToken, await deps.stepUp('data-import-apply')),
          body: JSON.stringify({ table, rows: rows.slice(i, i + batchRows) }),
        }), 'batch-failed');
        const created = isObject(data.created) ? data.created : {};
        const didSkip = isObject(data.skipped) ? data.skipped : {};
        applied[table] = (applied[table] ?? 0) + Number(created[table] ?? 0);
        skipped[table] = (skipped[table] ?? 0) + Number(didSkip[table] ?? 0);
        for (const r of (Array.isArray(data.rejected) ? data.rejected : []) as { table?: unknown; sourceId?: unknown; code?: unknown }[]) {
          rejected.push({ table: String(r.table ?? table), sourceId: String(r.sourceId ?? ''), code: String(r.code ?? 'insert_failed') });
        }
      }
      doneTables++;
      opts.onProgress?.({
        stage: 'apply', table, rows: (applied[table] ?? 0) + (skipped[table] ?? 0), media: 0, bytes: 0,
        totalTables, doneTables,
      }).catch(() => {});
    }
  }

  // 4. Upload media objects from the media volumes. The engine verifies each
  //    sha256 and rewrites the key under the target tenant.
  const mediaIndexBytes = readRootEntry(rootZip, preview.manifest.media.index.path);
  let mediaUploaded = 0;
  if (mediaIndexBytes) {
    for (const media of parseMediaIndex(mediaIndexBytes)) {
      const volumeBytes = volumeCache.get(media.volume);
      if (!volumeBytes) throw new Error(`media-volume:${media.volume}`);
      const bytes = readPackageEntry(volumeBytes, media.entry, media.bytes);
      if (!bytes) throw new Error(`media-entry:${media.entry}`);
      const res = await deps.http.request({
        url: deps.endpoints.importMedia(jobId, {
          key: media.key, sha256: media.sha256, bytes: media.bytes,
          contentType: media.content_type, entry: media.entry, volume: media.volume,
        }),
        method: 'POST', headers: { ...headers(deps, jobToken, await deps.stepUp('data-import-apply')), 'content-type': 'application/octet-stream' },
        body: bytes,
      });
      if (res.status < 200 || res.status >= 300) throw new Error('media-upload-failed');
      mediaUploaded++;
    }
  }

  // 5. Upload the evidence archive (events + keys) from the root volume.
  let archiveOk = false;
  const esignEvents = readRootEntry(rootZip, 'esign/events.ndjson');
  const esignKeys = readRootEntry(rootZip, 'esign/keys.ndjson');
  if (esignEvents && esignKeys) {
    const events = new TextDecoder().decode(esignEvents).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const keys = new TextDecoder().decode(esignKeys).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { fingerprint: string; pem: string });
    const res = await deps.http.request({
      url: deps.endpoints.importArchive(jobId), method: 'PUT', headers: headers(deps, jobToken, await deps.stepUp('data-import-apply')),
      body: JSON.stringify({ events, keys }),
    });
    archiveOk = dataOf(res, 'archive-failed').ok === true;
  }

  // 6. Attest completion (client-declared counts; no package content). The E2E
  //    revert harness skips this so the job stays live and revert can drive it.
  if (!opts.skipComplete) {
    await deps.http.request({
      url: deps.endpoints.complete(jobId), method: 'POST', headers: headers(deps, jobToken),
      body: JSON.stringify({ counts: preview.counts, bytes: 0, sha256: preview.manifest.packageId, excluded: preview.excluded }),
    });
    await deps.state.clear();
  }

  return {
    jobId, jobToken, packageId: preview.manifest.packageId, applied, skipped, rejected,
    mediaUploaded, archiveOk, preview,
  };
}

/**
 * Drive the revert loop to completion. `stepUpToken` is a factory because the
 * engine's step-up token is single-use: the host mints a fresh one per step.
 * Revert irreversibly deletes all imported rows — the UI must warn the owner.
 */
export async function runRevert(
  deps: ImportRunnerDeps,
  jobId: string,
  jobToken: string,
  stepUpToken: () => Promise<string>,
): Promise<RevertResult> {
  let done = false;
  let processed = 0;
  let step = 0;
  while (!done) {
    step++;
    const token = await stepUpToken();
    const data = dataOf(await deps.http.request({
      url: deps.endpoints.revertStep(jobId), method: 'POST',
      headers: headers(deps, jobToken, token), body: JSON.stringify({}),
    }), 'revert-failed');
    done = data.done === true;
    processed += Number(data.processed ?? 0);
  }
  return { done, processed, step };
}
