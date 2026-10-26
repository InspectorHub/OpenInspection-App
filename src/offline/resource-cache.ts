import type { Db } from '../platform/db';
import { accountKey as accountKeyOf } from './outbox';
import { isLocalId } from './registry';

/**
 * The local copy of the server's JSON reads (`resource_cache`). Every row belongs to one account (`account_key`)
 * and one package (`package_id`): an inspection id, or `GLOBAL_PACKAGE_ID` for the reads that are not about one
 * inspection. A package's rows are only ever replaced as a whole, in one transaction, so a reader never sees half
 * of one fetch and half of another.
 */

/** Not a valid inspection id (`$` is outside the id charset), so no inspection can collide with it. */
export const GLOBAL_PACKAGE_ID = '$global';
/**
 * The marker rows that say why an inspection's last refresh failed. There is one per inspection, keyed
 * `$refresh_error:<inspectionId>` (the table's key is unique per account, so a shared key would let one inspection's
 * failure overwrite another's). The body is a fixed code from the refresher. A marker lives in the package it
 * describes, so a purge, a clear and a successful replacement all remove it with the package and it needs no table or
 * `device_state` key of its own. `$` is outside the api-path pattern, so no fetched resource can collide with one.
 */
export const REFRESH_ERROR_PREFIX = '$refresh_error:';

/** The marker key of one inspection. The id is checked, so a marker key can never be built from free text. */
export function refreshErrorKey(inspectionId: string): string {
  if (!isLocalId(inspectionId)) throw new RangeError('invalid inspection id');
  return `${REFRESH_ERROR_PREFIX}${inspectionId}`;
}
const KEY_PATTERN = /^\/api\//;

export interface CachedResource {
  etag: string | null;
  body: string;
  fetchedAt: number;
}

export interface StagedResource {
  etag?: string | null;
  body: string;
  fetchedAt: number;
}

interface CacheRow {
  etag: string | null;
  body: string;
  fetched_at: number;
}

function assertKeys(resources: ReadonlyMap<string, StagedResource>): void {
  for (const key of resources.keys()) {
    if (!KEY_PATTERN.test(key)) throw new Error('resource_cache keys are api paths');
  }
}

async function insertAll(tx: Db, account: string, packageId: string, resources: ReadonlyMap<string, StagedResource>): Promise<void> {
  for (const [key, value] of resources) {
    await tx.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, ?, ?, ?, ?)', [account, key, value.etag ?? null, value.body, value.fetchedAt, packageId]);
  }
}

export async function readCached(db: Db, account: string, key: string): Promise<CachedResource | null> {
  const rows = await db.query<CacheRow>('SELECT etag, body, fetched_at FROM resource_cache WHERE account_key = ? AND key = ?', [account, key]);
  const row = rows[0];
  return row === undefined ? null : { etag: row.etag, body: row.body, fetchedAt: row.fetched_at };
}

/** The asked keys of one account; a key that is not cached is simply absent from the map. */
export async function readCachedBodies(db: Db, account: string, keys: readonly string[]): Promise<Map<string, CachedResource>> {
  const found = new Map<string, CachedResource>();
  for (const key of keys) {
    const row = await readCached(db, account, key);
    if (row !== null) found.set(key, row);
  }
  return found;
}

export type ReplaceOutcome = 'replaced' | 'no_package' | 'purging' | 'stale_generation' | 'other_account' | 'not_refreshable';

export interface ReplaceInspectionInput {
  accountKey: string;
  inspectionId: string;
  /** The generation the caller read before it started fetching. A newer one means someone else replaced the set since. */
  packageGen: number;
  resources: ReadonlyMap<string, StagedResource>;
  /** Becomes `work_package.refreshed_at`. */
  refreshedAt: number;
}

const MAX_REPORT_ID_LENGTH = 128;

/** The server's primary report id from the cached inspection read (`data.primaryReportId`), or null when absent or unusable. */
export function primaryReportIdOf(resource: StagedResource | undefined): string | null {
  if (resource === undefined) return null;
  try {
    const body: unknown = JSON.parse(resource.body);
    const data = typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
    const id = typeof data === 'object' && data !== null ? (data as { primaryReportId?: unknown }).primaryReportId : undefined;
    return typeof id === 'string' && id.length > 0 && id.length <= MAX_REPORT_ID_LENGTH ? id : null;
  } catch {
    return null;
  }
}

/**
 * Replaces every cached resource of one inspection in ONE short transaction, after checking in that same
 * transaction that the package still exists, is not being purged, is not quarantined, is still confirmed by the server, belongs to
 * this account and is still at the generation the caller fetched against. A refresh that finishes after a purge or after a newer refresh therefore
 * writes nothing. A failure anywhere rolls the whole set back.
 */
export async function replaceInspectionResources(db: Db, input: ReplaceInspectionInput): Promise<ReplaceOutcome> {
  assertKeys(input.resources);
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ tenant_id: string | null; user_id: string | null; purging: number; package_gen: number; quarantine_source: string | null; server_confirmed: number }>(
      'SELECT tenant_id, user_id, purging, package_gen, quarantine_source, server_confirmed FROM work_package WHERE inspection_id = ?',
      [input.inspectionId],
    );
    const row = rows[0];
    if (row === undefined) return 'no_package';
    if (row.tenant_id === null || row.user_id === null || accountKeyOf({ tenantId: row.tenant_id, userId: row.user_id }) !== input.accountKey) return 'other_account';
    if (row.purging !== 0) return 'purging';
    if (row.quarantine_source !== null || row.server_confirmed !== 1) return 'not_refreshable';
    if (row.package_gen !== input.packageGen) return 'stale_generation';
    const bumped = await tx.run('UPDATE work_package SET package_gen = package_gen + 1, refreshed_at = ? WHERE inspection_id = ? AND package_gen = ? AND purging = 0 AND quarantine_source IS NULL AND server_confirmed = 1', [input.refreshedAt, input.inspectionId, input.packageGen]);
    if (bumped.changes !== 1) return 'stale_generation';
    await tx.run('DELETE FROM resource_cache WHERE account_key = ? AND package_id = ?', [input.accountKey, input.inspectionId]);
    await insertAll(tx, input.accountKey, input.inspectionId, input.resources);
    const reportId = primaryReportIdOf(input.resources.get(`/api/inspections/${input.inspectionId}`));
    // Only a usable id is stored, and never over a stored one with nothing: an old server that does not send it changes no row.
    if (reportId !== null) await tx.run('UPDATE work_package SET report_id = ? WHERE inspection_id = ? AND tenant_id = ? AND user_id = ?', [reportId, input.inspectionId, row.tenant_id, row.user_id]);
    return 'replaced';
  });
}

/** The reads that are not about one inspection, replaced as a set in their own transaction. */
export async function replaceGlobalResources(db: Db, input: { accountKey: string; resources: ReadonlyMap<string, StagedResource> }): Promise<void> {
  assertKeys(input.resources);
  await db.transaction(async (tx) => {
    await tx.run('DELETE FROM resource_cache WHERE account_key = ? AND package_id = ?', [input.accountKey, GLOBAL_PACKAGE_ID]);
    await insertAll(tx, input.accountKey, GLOBAL_PACKAGE_ID, input.resources);
  });
}

/**
 * Remembers why an inspection's refresh failed. Written only while the package exists, is not being purged and
 * belongs to this account, so a marker is never left behind for a package that has gone or is someone else's. One
 * marker per inspection: a second failure replaces that inspection's marker and no other. The previous cache is not
 * touched.
 */
export async function recordRefreshError(db: Db, input: { accountKey: string; inspectionId: string; code: string; at: number }): Promise<void> {
  const key = refreshErrorKey(input.inspectionId);
  await db.transaction(async (tx) => {
    const rows = await tx.query<{ tenant_id: string | null; user_id: string | null; purging: number }>('SELECT tenant_id, user_id, purging FROM work_package WHERE inspection_id = ?', [input.inspectionId]);
    const row = rows[0];
    if (row === undefined || row.purging !== 0 || row.tenant_id === null || row.user_id === null) return;
    if (accountKeyOf({ tenantId: row.tenant_id, userId: row.user_id }) !== input.accountKey) return;
    await tx.run('INSERT OR REPLACE INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [input.accountKey, key, input.code, input.at, input.inspectionId]);
  });
}

export async function clearRefreshError(db: Db, accountKey: string, inspectionId: string): Promise<void> {
  await db.run('DELETE FROM resource_cache WHERE account_key = ? AND package_id = ? AND key = ?', [accountKey, inspectionId, refreshErrorKey(inspectionId)]);
}

/** Inspections of this account that hold at least one fetched resource (a marker alone does not count). */
export async function packagesWithCachedRows(db: Db, accountKey: string): Promise<Set<string>> {
  const rows = await db.query<{ package_id: string }>("SELECT DISTINCT package_id FROM resource_cache WHERE account_key = ? AND package_id <> ? AND SUBSTR(key, 1, 5) = '/api/'", [accountKey, GLOBAL_PACKAGE_ID]);
  return new Set(rows.map((r) => r.package_id));
}

/** Bytes of fetched resources one package holds, markers excluded. */
export async function packageBytes(db: Db, accountKey: string, packageId: string): Promise<number> {
  const rows = await db.query<{ n: number | null }>("SELECT SUM(LENGTH(CAST(body AS BLOB))) AS n FROM resource_cache WHERE account_key = ? AND package_id = ? AND SUBSTR(key, 1, 5) = '/api/'", [accountKey, packageId]);
  return rows[0]?.n ?? 0;
}

/** Bytes of body text one account holds, markers included. */
export async function cacheBytes(db: Db, account: string): Promise<number> {
  const rows = await db.query<{ n: number | null }>('SELECT SUM(LENGTH(CAST(body AS BLOB))) AS n FROM resource_cache WHERE account_key = ?', [account]);
  return rows[0]?.n ?? 0;
}

/**
 * True for a package nothing on this device depends on: confirmed by the server, not pinned, not quarantined, not
 * being purged, with no queued write, no media row of any state and no Yjs update (`results-<id>` is `resultsDocName`; a test pins the two together). Deliberately narrower than the
 * final "unsent data" rule (a later task owns that one): anything with a trace of local work is kept.
 */
const EVICTABLE = `
  EXISTS (SELECT 1 FROM work_package w WHERE w.inspection_id = resource_cache.package_id AND w.server_confirmed = 1 AND w.pinned = 0
          AND w.purging = 0 AND w.quarantine_source IS NULL AND w.tenant_id = ? AND w.user_id = ?)
  AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.inspection_id = resource_cache.package_id)
  AND NOT EXISTS (SELECT 1 FROM media m WHERE m.inspection_id = resource_cache.package_id)
  AND NOT EXISTS (SELECT 1 FROM ydoc_updates y WHERE y.doc_name = 'results-' || resource_cache.package_id)`;

export interface EvictResult {
  /** Inspections whose cached set was dropped, oldest first. */
  evicted: string[];
  /** Bytes this account still holds. */
  bytes: number;
}

/**
 * Drops whole inspections' cached sets, oldest first, until the account is at or under `capBytes` or nothing
 * evictable is left. Only this account's rows go, and never the global set. The protection test is part of the
 * DELETE statement itself, so a write queued between choosing and deleting still protects its inspection.
 */
export async function evictOverCap(db: Db, input: { accountKey: string; capBytes: number }): Promise<EvictResult> {
  let bytes = await cacheBytes(db, input.accountKey);
  const evicted: string[] = [];
  if (bytes <= input.capBytes) return { evicted, bytes };
  const owners = await db.query<{ package_id: string; oldest: number; tenant_id: string | null; user_id: string | null }>(
    `SELECT r.package_id AS package_id, MIN(r.fetched_at) AS oldest, w.tenant_id AS tenant_id, w.user_id AS user_id
     FROM resource_cache r JOIN work_package w ON w.inspection_id = r.package_id
     WHERE r.account_key = ? AND r.package_id <> ? AND SUBSTR(r.key, 1, 5) = '/api/' GROUP BY r.package_id ORDER BY oldest ASC, r.package_id ASC`,
    [input.accountKey, GLOBAL_PACKAGE_ID],
  );
  for (const candidate of owners) {
    if (bytes <= input.capBytes) break;
    if (candidate.tenant_id === null || candidate.user_id === null || accountKeyOf({ tenantId: candidate.tenant_id, userId: candidate.user_id }) !== input.accountKey) continue;
    const dropped = await db.transaction(async (tx) => {
      const result = await tx.run(`DELETE FROM resource_cache WHERE account_key = ? AND package_id = ? AND ${EVICTABLE}`, [input.accountKey, candidate.package_id, candidate.tenant_id, candidate.user_id]);
      if (result.changes > 0) await tx.run('UPDATE work_package SET refreshed_at = 0 WHERE inspection_id = ?', [candidate.package_id]);
      return result.changes > 0;
    });
    if (dropped) {
      evicted.push(candidate.package_id);
      bytes = await cacheBytes(db, input.accountKey);
    }
  }
  return { evicted, bytes };
}
