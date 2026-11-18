/**
 * Page through E-1's keyset row API and write NDJSON shards for one export.
 *
 * Pure and injectable: `http` is a request function, `files` an in-memory-capable
 * writer, and the caller owns credentials/endpoints. Every untrusted field from
 * the server response (cursor, row object, byte count) is validated before use,
 * and hard caps bound how many pages/rows a table can consume so a malicious or
 * broken server cannot spin the loop forever.
 *
 * Resume: `startCursor` is the last keyset cursor persisted in the checkpoint;
 * a resumed table starts from it instead of re-reading from the beginning.
 */
import { encodeNdjsonRow, ShardCutter } from '@inspectorhub/data-package';
import type { JsonObject } from '@inspectorhub/data-package';
import type {
  ExportFs, RunnerRequest, TableDescriptor, WrittenFile, ExportCredentials, ProgressFn,
} from './types';

const MAX_CURSOR_CHARS = 2048;
const MAX_PAGES_PER_TABLE = 100_000;
const MAX_ROWS_PER_TABLE = 5_000_000;
const MAX_SHARD_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ROWS_PER_SHARD = 50_000;

export interface RowsDeps {
  readonly http: RunnerRequest;
  readonly files: ExportFs;
  readonly credentials: ExportCredentials;
  /** Base URL builder: (table, after?, limit?) => full URL. Owned by caller so secrets never enter a URL. */
  readonly rowsUrl: (table: string, after: string | null, limit: number) => string;
  readonly headers: () => Record<string, string>;
  readonly log?: (line: string) => void;
}

export interface TableRowResult {
  readonly table: string;
  readonly cursor: string | null;
  readonly rows: number;
  readonly bytes: number;
  readonly files: readonly WrittenFile[];
}

export interface RowsResult {
  readonly tables: readonly TableRowResult[];
  readonly totalRows: number;
  readonly totalBytes: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate one page response: `{ rows: object[], next: string|null, bytes, rowsScanned }`. */
function parsePage(json: unknown): { rows: JsonObject[]; next: string | null } {
  if (!isObject(json) || !isObject(json.data)) throw new Error('rows-response');
  const data = json.data;
  if (!Array.isArray(data.rows)) throw new Error('rows-response');
  const next = data.next;
  if (next !== null && (typeof next !== 'string' || next.length > MAX_CURSOR_CHARS)) throw new Error('rows-cursor');
  const rows: JsonObject[] = [];
  for (const row of data.rows) {
    if (!isObject(row)) throw new Error('rows-row');
    rows.push(row as JsonObject);
  }
  return { rows, next };
}

/** Write one table's shards; returns per-table progress and final cursor. */
export async function readTable(
  deps: RowsDeps,
  table: TableDescriptor,
  startCursor: string | null,
  onRow?: (rows: number, bytes: number) => void | Promise<void>,
): Promise<TableRowResult> {
  const cutter = new ShardCutter(table.table, {
    maxRows: Math.min(DEFAULT_MAX_ROWS_PER_SHARD, Math.max(1, table.maxPageRows * 100)),
    maxBytes: Math.min(MAX_SHARD_BYTES, Math.max(1, table.maxPageBytes * 100)),
  });
  const files: WrittenFile[] = [];
  let current: { path: string; chunks: Uint8Array[]; rows: number; bytes: number } | null = null;
  let cursor = startCursor;
  let rows = 0;
  let bytes = 0;
  let pages = 0;

  const closeCurrent = (): void => {
    if (current !== null) {
      const joined = new Uint8Array(current.bytes);
      let off = 0;
      for (const chunk of current.chunks) { joined.set(chunk, off); off += chunk.length; }
      files.push({ path: current.path, bytes: joined, rows: current.rows });
      current = null;
    }
  };

  do {
    if (++pages > MAX_PAGES_PER_TABLE) throw new Error('rows-too-many-pages');
    const limit = Math.max(1, table.maxPageRows);
    const res = await deps.http({ url: deps.rowsUrl(table.table, cursor, limit), method: 'GET', headers: deps.headers() });
    if (res.status !== 200) throw new Error(`rows-status-${res.status}`);
    const page = parsePage(res.json);

    for (const row of page.rows) {
      if (++rows > MAX_ROWS_PER_TABLE) throw new Error('rows-too-many-rows');
      const line = encodeNdjsonRow(row);
      const placement = cutter.place(line.length);
      if (placement.opensShard) {
        closeCurrent();
        current = { path: placement.path, chunks: [], rows: 0, bytes: 0 };
      }
      if (current === null) throw new Error('rows-shard');
      current.chunks.push(line);
      current.rows += 1;
      current.bytes += line.length;
      bytes += line.length;
      if (onRow) await onRow(rows, bytes);
    }
    cursor = page.next;
  } while (cursor !== null);

  closeCurrent();
  // A table with zero rows still needs a zero-byte shard so counts reconcile.
  if (files.length === 0) files.push({ path: `data/${table.table}.ndjson`, bytes: new Uint8Array(0), rows: 0 });
  deps.log?.(`rows ${table.table}: ${rows} rows, ${bytes} bytes`);
  return { table: table.table, cursor, rows, bytes, files };
}

/** Read every table, starting each from its checkpoint cursor. */
export async function readAllRows(
  deps: RowsDeps,
  tables: readonly TableDescriptor[],
  cursors: Readonly<Record<string, string | null>>,
  onProgress?: ProgressFn,
): Promise<RowsResult> {
  const results: TableRowResult[] = [];
  let totalRows = 0;
  let totalBytes = 0;
  for (const table of tables) {
    const result = await readTable(deps, table, cursors[table.table] ?? null, (rows, bytes) =>
      onProgress?.({
        stage: 'rows', table: table.table, rows: totalRows + rows, media: 0,
        bytes: totalBytes + bytes, totalTables: tables.length, doneTables: results.length,
      }));
    results.push(result);
    totalRows += result.rows;
    totalBytes += result.bytes;
  }
  return { tables: results, totalRows, totalBytes };
}
