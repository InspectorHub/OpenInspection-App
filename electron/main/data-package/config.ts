/**
 * Fixed configuration for the desktop client's calls to the engine's dumb
 * data-package API. There is no discovery document: the base path and the
 * route shape are a contract shared with the engine (E-1) and pinned here.
 *
 * The API lives under the admin router and carries only the native owner
 * bearer plus the short-lived per-job `X-Data-Job` token. `jobToken` and the
 * step-up token are never part of a URL — they travel in headers only, so
 * nothing here ever builds a secret into a path.
 */

export const DATA_PACKAGE_BASE_PATH = '/api/admin/data-package';

/** A URL path segment we are willing to build into a request: no separator, whitespace, dot-segment or non-ASCII. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && value !== '.' && value !== '..';
}

function segment(value: string, label: string): string {
  if (!isSafeSegment(value)) throw new Error(`unsafe ${label}`);
  return value;
}

/** The only accepted server origin: http(s), no path, query, fragment or credentials. */
function assertOrigin(origin: string): void {
  let url: URL;
  try { url = new URL(origin); } catch { throw new Error('invalid origin'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password ||
      url.hostname === '' || url.pathname !== '/' || url.search || url.hash || url.origin !== origin) {
    throw new Error('invalid origin');
  }
}

export interface DataPackageEndpoints {
  readonly jobs: string;
  job(id: string): string;
  heartbeat(id: string): string;
  resume(id: string): string;
  complete(id: string): string;
  abort(id: string): string;
  tables(id: string): string;
  rows(id: string, table: string): string;
}

/** All data-package endpoints under one verified origin. Unsafe segments throw rather than being encoded. */
export function dataPackageEndpoints(origin: string): DataPackageEndpoints {
  assertOrigin(origin);
  const base = `${origin}${DATA_PACKAGE_BASE_PATH}`;
  const job = (id: string): string => `${base}/jobs/${segment(id, 'job id')}`;
  return {
    jobs: `${base}/jobs`,
    job,
    heartbeat: (id) => `${job(id)}/heartbeat`,
    resume: (id) => `${job(id)}/resume`,
    complete: (id) => `${job(id)}/complete`,
    abort: (id) => `${job(id)}/abort`,
    tables: (id) => `${job(id)}/tables`,
    rows: (id, table) => `${job(id)}/tables/${segment(table, 'table')}/rows`,
  };
}

export type ReadProfile = 'worker-free' | 'worker-paid';

/** Parsed `X-Dp-Budget` measurement header. Application budgets are disabled; these are ceilings, not a 429 signal. */
export interface BudgetHeader {
  readonly reads: string;
  readonly writes: string;
  readonly profile: ReadProfile;
  readonly pageRows: number;
  readonly pageBytes: number;
}

function parseProfile(value: string | undefined): ReadProfile | null {
  return value === 'worker-free' || value === 'worker-paid' ? value : null;
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Parses the E-1 header `reads=0/0;writes=0/0;profile=<p>;pageRows=<n>;pageBytes=<n>`.
 * Returns null when a required field is absent or invalid so a caller never
 * acts on a partial budget. Reads/writes are kept as raw `used/cap` strings:
 * with application budgets disabled they are for measurement only.
 */
export function parseBudgetHeader(raw: string | null): BudgetHeader | null {
  if (raw === null || raw.trim() === '') return null;
  const fields = new Map<string, string>();
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) return null;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === '' || value === '' || fields.has(key)) return null;
    fields.set(key, value);
  }
  const profile = parseProfile(fields.get('profile'));
  const pageRows = positiveInt(fields.get('pageRows'));
  const pageBytes = positiveInt(fields.get('pageBytes'));
  const reads = fields.get('reads');
  const writes = fields.get('writes');
  if (profile === null || pageRows === null || pageBytes === null || reads === undefined || writes === undefined) return null;
  return { reads, writes, profile, pageRows, pageBytes };
}
