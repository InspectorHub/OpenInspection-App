/**
 * Shared types for the desktop-owned export runner (A-2). The runner lives in
 * the main process and never touches IPC directly: it reports progress through
 * a callback, and the IPC layer forwards small progress objects to the renderer
 * (bytes never cross IPC).
 */
import type { BudgetHeader } from './config';

/** A file the runner wrote into the package staging directory, in memory for assembly. */
export interface WrittenFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Row count for NDJSON data/esign files; absent for fixed files. */
  readonly rows?: number;
}

/** Minimal filesystem surface the runner needs. Injected so tests use an in-memory fs. */
export interface ExportFs {
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, data: Uint8Array, options?: { mode?: number; flag?: string }): Promise<void>;
  /** Read bytes back for the self-check (real fs; in-memory fs in tests). */
  readFile(path: string): Promise<Uint8Array>;
  /** Atomic publish of a `.part` file to its final path. */
  rename(oldPath: string, newPath: string): Promise<void>;
}

/** One response from the restricted HTTP client, narrowed to what the runner uses. */
export interface RunnerResponse {
  readonly status: number;
  readonly json: unknown;
  readonly text: string;
  readonly budget: BudgetHeader | null;
}

export type RunnerRequest = (req: {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}) => Promise<RunnerResponse>;

/** Table descriptor from E-1 `GET /tables` (only the fields the runner needs). */
export interface TableDescriptor {
  readonly table: string;
  readonly columns: readonly string[];
  readonly keyset: readonly string[];
  readonly rowCountAtSnapshot?: number;
  readonly maxPageRows: number;
  readonly maxPageBytes: number;
  readonly blobColumns?: readonly { property: string; name: string }[];
}

/** A media object descriptor from E-2 `GET /media` (key relative to tenant prefix). */
export interface MediaDescriptor {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly uploaded: number;
  readonly contentType: string;
  readonly kind: 'image' | 'video' | 'audio' | 'document' | 'other';
}

/** A media index row as written into `media/index.ndjson` (shape pinned by the format package). */
export interface MediaIndexRow {
  readonly key: string;
  readonly entry: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly volume: string;
  readonly content_type: string;
  readonly referenced_by: { table: string; id: string }[];
}

/** Credentials supplied by the caller from main-process memory; never persisted or put in a URL. */
export interface ExportCredentials {
  /** Native owner bearer token. */
  readonly bearer: string;
  /** Short-lived per-job token, refreshed on heartbeat. */
  jobToken: string;
}

/** Progress pushed to the IPC layer. No bytes, no secrets. */
export interface ExportProgress {
  readonly stage: 'rows' | 'media' | 'verifying' | 'finishing';
  readonly table?: string;
  readonly rows: number;
  readonly media: number;
  readonly bytes: number;
  readonly totalTables: number;
  readonly doneTables: number;
  /** Preview of total work from snapshot metadata, on the first progress event. */
  readonly estimate?: { rows: number; bytes: number; days: number };
  /** True while the user has paused the run. */
  readonly paused?: boolean;
  /** Set when the job pauses for budget/429 with a UTC reset time. */
  readonly pausedUntil?: string;
}

export interface ExcludedItem {
  readonly class: 'withheld_secret' | 'out_of_scope' | 'unclassified_column' | 'external_media' | 'mode_bound' | 'oversize_media' | 'bad_media';
  readonly table: string;
  readonly reason: string;
  readonly ids?: readonly string[];
  readonly columns?: readonly string[];
}

/** Always async: the main session awaits it at every stage boundary so pause/cancel take effect. */
export type ProgressFn = (progress: ExportProgress) => Promise<void>;
