/**
 * Persistent resume checkpoint for a desktop-owned data job. The job token and
 * the step-up token are NEVER written here — they live only in main-process
 * memory for the life of the lease. This file holds only the non-secret
 * position needed to resume after a restart: which job, which tables, the last
 * keyset cursor of each, and the client's running attestation counts.
 *
 * Writes are serialized and atomic (temp file + rename), and a corrupt file is
 * refused rather than discarded: silently dropping a checkpoint would make a
 * resumed export re-read everything from the start.
 */
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type JobKind = 'export' | 'import';
export const JOB_STAGES = ['rows', 'media', 'finish', 'upload', 'preview', 'apply', 'revert'] as const;
export type JobStage = (typeof JOB_STAGES)[number];

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEVICE_LABEL_MAX = 128;
const CURSOR_MAX = 4096; // matches the DB CHECK on tenant_data_jobs.cursor
const TABLE_NAME = /^[A-Za-z0-9_]{1,64}$/;
const TABLES_MAX = 256;

export interface TableProgress {
  readonly cursor: string | null;
  readonly rows: number;
  readonly bytes: number;
}

export interface JobCheckpoint {
  readonly jobId: string;
  readonly kind: JobKind;
  readonly deviceLabel: string;
  readonly snapshotAt: number;
  readonly stage: JobStage;
  readonly tables: Record<string, TableProgress>;
  readonly counts: { readonly rows: number; readonly media: number };
  readonly bytes: number;
  readonly updatedAt: number;
}

export interface StateFs {
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer, options?: { mode?: number; flag?: string }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface DataPackageStateHost {
  load(): Promise<JobCheckpoint | null>;
  save(checkpoint: JobCheckpoint): Promise<void>;
  clear(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function keysExactly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(value).every((k) => set.has(k));
}

/** Strict validation of an untrusted on-disk checkpoint; returns a typed value or null. */
function parseCheckpoint(value: unknown): JobCheckpoint | null {
  if (!isObject(value) || !keysExactly(value, ['jobId', 'kind', 'deviceLabel', 'snapshotAt', 'stage', 'tables', 'counts', 'bytes', 'updatedAt'])) return null;
  if (typeof value.jobId !== 'string' || !JOB_ID.test(value.jobId)) return null;
  if (value.kind !== 'export' && value.kind !== 'import') return null;
  if (typeof value.deviceLabel !== 'string' || value.deviceLabel.length === 0 || value.deviceLabel.length > DEVICE_LABEL_MAX) return null;
  if (!timestamp(value.snapshotAt) || !timestamp(value.updatedAt)) return null;
  if (typeof value.stage !== 'string' || !(JOB_STAGES as readonly string[]).includes(value.stage)) return null;
  if (!nonNegInt(value.bytes) || !isObject(value.counts)) return null;
  if (!keysExactly(value.counts, ['rows', 'media']) || !nonNegInt(value.counts.rows) || !nonNegInt(value.counts.media)) return null;
  if (!isObject(value.tables) || Object.keys(value.tables).length > TABLES_MAX) return null;
  const tables: Record<string, TableProgress> = Object.create(null) as Record<string, TableProgress>;
  for (const [name, raw] of Object.entries(value.tables)) {
    if (!TABLE_NAME.test(name) || !isObject(raw) || !keysExactly(raw, ['cursor', 'rows', 'bytes'])) return null;
    if (raw.cursor !== null && (typeof raw.cursor !== 'string' || raw.cursor.length > CURSOR_MAX)) return null;
    if (!nonNegInt(raw.rows) || !nonNegInt(raw.bytes)) return null;
    tables[name] = { cursor: raw.cursor as string | null, rows: raw.rows, bytes: raw.bytes };
  }
  return {
    jobId: value.jobId, kind: value.kind, deviceLabel: value.deviceLabel,
    snapshotAt: value.snapshotAt, stage: value.stage as JobStage,
    tables, counts: { rows: value.counts.rows, media: value.counts.media },
    bytes: value.bytes, updatedAt: value.updatedAt,
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export function createDataPackageStateHost(deps: { fs: StateFs; file: string; now: () => number }): DataPackageStateHost {
  let pending = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };

  async function rejectSymlink(): Promise<void> {
    let stats: { isSymbolicLink(): boolean };
    try { stats = await deps.fs.lstat(deps.file); }
    catch (error) { if (isMissing(error)) return; throw error; }
    if (stats.isSymbolicLink()) throw new Error('state-symlink');
  }

  return {
    load: () => serialized(async () => {
      await rejectSymlink();
      let bytes: Buffer;
      try { bytes = await deps.fs.readFile(deps.file); }
      catch (error) { if (isMissing(error)) return null; throw error; }
      let parsed: unknown;
      try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('state-unreadable'); }
      const checkpoint = parseCheckpoint(parsed);
      if (checkpoint === null) throw new Error('state-unreadable');
      return checkpoint;
    }),
    save: (checkpoint) => serialized(async () => {
      await rejectSymlink();
      // updatedAt is always stamped by the host, never trusted from the caller.
      const stamped: JobCheckpoint = { ...checkpoint, updatedAt: deps.now() };
      // Parse to a freshly rebuilt object and write THAT. Writing the caller's
      // object directly would let a hidden `toJSON`/getter smuggle a field
      // (potentially a token) into the file even though validation passed.
      const clean = parseCheckpoint(stamped);
      if (clean === null) throw new Error('state-unreadable');
      await deps.fs.mkdir(dirname(deps.file), { recursive: true, mode: 0o700 });
      const temporary = `${deps.file}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await deps.fs.writeFile(temporary, Buffer.from(JSON.stringify(clean), 'utf8'), { mode: 0o600, flag: 'wx' });
        await deps.fs.rename(temporary, deps.file);
      } catch (error) {
        await deps.fs.unlink(temporary).catch(() => {});
        throw error;
      }
    }),
    clear: () => serialized(async () => {
      await rejectSymlink();
      await deps.fs.unlink(deps.file).catch((error) => { if (!isMissing(error)) throw error; });
    }),
  };
}
