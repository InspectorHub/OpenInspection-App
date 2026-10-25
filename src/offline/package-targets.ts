import type { Db } from '../platform/db';
import { accountKey as accountKeyOf, sameAccount, type Account } from './outbox';
import { isLocalId } from './registry';
import { REFRESH_ERROR_PREFIX } from './resource-cache';

/**
 * Which inspections a refresh downloads, in what order, and what the work list may read back about them.
 * The server decides what is listed; the device decides what it already holds (pins, local creates, other accounts).
 */

export const DEFAULT_SYNC_DAYS = 14;
export const MIN_SYNC_DAYS = 1;
export const MAX_SYNC_DAYS = 60;
const DAY_MS = 86_400_000;

/** Failure codes of one inspection's refresh. Fixed strings: nothing the server said is ever one of them. */
export const REFRESH_ERROR_CODES = ['not_found', 'not_visible', 'refused', 'invalid_response', 'too_large', 'rate_limited', 'server_error', 'network', 'storage_failed'] as const;
export type RefreshErrorCode = (typeof REFRESH_ERROR_CODES)[number];

export function isRefreshErrorCode(value: unknown): value is RefreshErrorCode {
  return typeof value === 'string' && (REFRESH_ERROR_CODES as readonly string[]).includes(value);
}

export function clampSyncDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_SYNC_DAYS;
  return Math.min(MAX_SYNC_DAYS, Math.max(MIN_SYNC_DAYS, Math.trunc(days)));
}

/** The person's `sync_days` setting: digits only, clamped to 1..60; anything else is the default. */
export async function readSyncDays(db: Db): Promise<number> {
  const rows = await db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'sync_days'");
  const value = rows[0]?.value;
  if (value === undefined || !/^\d{1,6}$/.test(value)) return DEFAULT_SYNC_DAYS;
  return clampSyncDays(Number(value));
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The window asked of the server: a day of slack on each side, because the server's day is the company's and ours is UTC. */
export function windowFor(now: number, syncDays: number): { dateFrom: string; dateTo: string } {
  return { dateFrom: utcDay(now - DAY_MS), dateTo: utcDay(now + (syncDays + 1) * DAY_MS) };
}

export interface Target {
  id: string;
  scheduledAt: number | null;
  completed: boolean;
  pinned: boolean;
  today: boolean;
  listed: boolean;
}

export interface ParsedList {
  items: Map<string, { scheduledAt: number | null; completed: boolean; today: boolean }>;
  /** Raw ids that were refused; strings are counted once however many queries returned them. */
  invalid: Set<string>;
  /** Items without a usable string id. */
  invalidAnonymous: number;
}

export function newParsedList(): ParsedList {
  return { items: new Map(), invalid: new Set(), invalidAnonymous: 0 };
}

/** Adds the rows of one list page. A row whose id could not be a path segment is counted and dropped; a cancelled one is dropped quietly. */
export function addListRows(into: ParsedList, rows: readonly unknown[], todayDay: string): void {
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      into.invalidAnonymous += 1;
      continue;
    }
    const item = row as Record<string, unknown>;
    const id = item.id;
    if (typeof id !== 'string') {
      into.invalidAnonymous += 1;
      continue;
    }
    if (!isLocalId(id)) {
      into.invalid.add(id);
      continue;
    }
    if (item.status === 'cancelled') continue;
    const date = typeof item.date === 'string' ? item.date : null;
    const parsed = date === null ? Number.NaN : Date.parse(date);
    into.items.set(id, { scheduledAt: Number.isFinite(parsed) ? parsed : null, completed: item.status === 'completed', today: date !== null && date.slice(0, 10) === todayDay });
  }
}

export interface PackageRow {
  inspection_id: string;
  package_gen: number;
  refreshed_at: number;
  pinned: number;
  scheduled_at: number | null;
  tenant_id: string | null;
  user_id: string | null;
  server_confirmed: number;
  purging: number;
  quarantine_source: string | null;
}

/** A package this account may refresh: its own, confirmed by the server, not being purged, not quarantined. */
export function isRefreshable(row: PackageRow, account: Account): boolean {
  return sameAccount(account, row.tenant_id, row.user_id) && row.server_confirmed === 1 && row.purging === 0 && row.quarantine_source === null;
}

export async function readPackageRow(db: Db, inspectionId: string): Promise<PackageRow | null> {
  const rows = await db.query<PackageRow>(
    'SELECT inspection_id, package_gen, refreshed_at, pinned, scheduled_at, tenant_id, user_id, server_confirmed, purging, quarantine_source FROM work_package WHERE inspection_id = ?',
    [inspectionId],
  );
  return rows[0] ?? null;
}

export async function readPackageRows(db: Db): Promise<Map<string, PackageRow>> {
  const rows = await db.query<PackageRow>('SELECT inspection_id, package_gen, refreshed_at, pinned, scheduled_at, tenant_id, user_id, server_confirmed, purging, quarantine_source FROM work_package');
  return new Map(rows.map((row) => [row.inspection_id, row]));
}

/**
 * Records what the server listed. A row is created for an inspection this device has not seen (not yet downloaded:
 * `refreshed_at` 0) and the schedule fields of an existing one are updated, but only when the row is this account's,
 * confirmed by the server, not quarantined and not being purged. Nothing is ever deleted here.
 */
export async function upsertListed(db: Db, account: Account, listed: ParsedList['items']): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [id, item] of listed) {
      await tx.run(
        `INSERT INTO work_package (inspection_id, scheduled_at, completed, refreshed_at, server_confirmed, tenant_id, user_id) VALUES (?, ?, ?, 0, 1, ?, ?)
         ON CONFLICT(inspection_id) DO UPDATE SET scheduled_at = excluded.scheduled_at, completed = excluded.completed
         WHERE work_package.tenant_id = excluded.tenant_id AND work_package.user_id = excluded.user_id AND work_package.server_confirmed = 1 AND work_package.purging = 0 AND work_package.quarantine_source IS NULL`,
        [id, item.scheduledAt, item.completed ? 1 : 0, account.tenantId, account.userId],
      );
    }
  });
}

/** Today's first, then pinned, then the rest of the window; inside a tier by scheduled time. */
export function orderTargets(targets: readonly Target[]): Target[] {
  const tier = (t: Target): number => (t.today ? 0 : t.pinned ? 1 : 2);
  return [...targets].sort((a, b) => tier(a) - tier(b) || (a.scheduledAt ?? Number.MAX_SAFE_INTEGER) - (b.scheduledAt ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Packages that have a recorded failure, which are due again at once whatever their age. */
export async function packagesWithError(db: Db, account: Account): Promise<Set<string>> {
  const rows = await db.query<{ package_id: string }>('SELECT package_id FROM resource_cache WHERE account_key = ? AND key = ? || package_id', [accountKeyOf(account), REFRESH_ERROR_PREFIX]);
  return new Set(rows.map((r) => r.package_id));
}

/** Packages whose last download was answered "not visible" (403 or 404 on the inspection itself), with when that was recorded. */
export async function notVisibleMarkers(db: Db, account: Account): Promise<Map<string, number>> {
  const rows = await db.query<{ package_id: string; fetched_at: number }>("SELECT package_id, fetched_at FROM resource_cache WHERE account_key = ? AND key = ? || package_id AND body = 'not_visible'", [accountKeyOf(account), REFRESH_ERROR_PREFIX]);
  return new Map(rows.map((r) => [r.package_id, Number(r.fetched_at)]));
}

export interface PackageState {
  inspectionId: string;
  /** When the cached set was last replaced, or null when it never was (or was dropped to make room). */
  lastRefreshedAt: number | null;
  lastError: RefreshErrorCode | null;
  cachedResources: number;
  pinned: boolean;
}

/** What the work list shows about each of this account's packages. Reads only; the account decides which rows are visible. */
export async function readPackageStates(db: Db, account: Account): Promise<PackageState[]> {
  const key = accountKeyOf(account);
  const rows = await db.query<{ inspection_id: string; refreshed_at: number; pinned: number; n: number; err: string | null }>(
    `SELECT w.inspection_id AS inspection_id, w.refreshed_at AS refreshed_at, w.pinned AS pinned,
       (SELECT COUNT(*) FROM resource_cache r WHERE r.account_key = ? AND r.package_id = w.inspection_id AND r.key <> ? || w.inspection_id) AS n,
       (SELECT r.body FROM resource_cache r WHERE r.account_key = ? AND r.package_id = w.inspection_id AND r.key = ? || w.inspection_id) AS err
     FROM work_package w WHERE w.tenant_id = ? AND w.user_id = ? ORDER BY w.inspection_id`,
    [key, REFRESH_ERROR_PREFIX, key, REFRESH_ERROR_PREFIX, account.tenantId, account.userId],
  );
  return rows.map((r) => ({ inspectionId: r.inspection_id, lastRefreshedAt: r.refreshed_at > 0 ? r.refreshed_at : null, lastError: isRefreshErrorCode(r.err) ? r.err : null, cachedResources: r.n, pinned: r.pinned === 1 }));
}
