import { safeClientHeaders } from '../auth/client-headers';
import { AuthError } from '../auth/errors';
import type { Http, HttpResponse } from '../auth/http';
import { parseServerUrl } from '../auth/server-config';
import { backoffMs, type TokenManager } from '../auth/tokens';
import { realTimers, type TimerPort } from '../collab/timers';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Network } from '../platform/network';
import { isLocalId } from './registry';
import { DEFAULT_LEASE_TTL_MS, SYNC_LEASE, withLease, type LeaseHandle } from './lease';
import type { AppStatePort } from './lock-monitor';
import { accountKey as accountKeyOf, sameAccount, type Account } from './outbox';
import {
  addListRows,
  isRefreshable,
  newParsedList,
  notVisibleMarkers,
  orderTargets,
  packagesWithError,
  readPackageRow,
  readPackageRows,
  readSyncDays,
  upsertListed,
  utcDay,
  windowFor,
  type ParsedList,
  type RefreshErrorCode,
  type Target,
} from './package-targets';
import {
  GLOBAL_PACKAGE_ID,
  cacheBytes,
  evictOverCap,
  packageBytes,
  packagesWithCachedRows,
  readCached,
  recordRefreshError,
  replaceGlobalResources,
  replaceInspectionResources,
  type StagedResource,
} from './resource-cache';
import {
  DEFAULT_JSON_LIMITS,
  GLOBAL_RESOURCE_PATHS,
  baseInspectionPaths,
  conditionalInspectionPaths,
  hasSuccessEnvelope,
  isJsonContentType,
  jsonWithinLimits,
  type JsonLimits,
} from './resources';

export { DEFAULT_SYNC_DAYS, MAX_SYNC_DAYS, MIN_SYNC_DAYS, clampSyncDays, readPackageStates, readSyncDays, REFRESH_ERROR_CODES } from './package-targets';
export type { PackageState, RefreshErrorCode } from './package-targets';

/**
 * Keeps the inspections the person works on downloaded: the server's JSON reads for each, cached on the device so
 * the editor opens without a connection. Files are not part of this (media and thumbnails have their own task).
 *
 * What a run does, in order: take the shared lease; read the list of mine in the `sync_days` window plus every
 * unfinished one of mine; add what is pinned here; order it (today, pinned, the rest); download each inspection's
 * resources into memory with at most three requests in flight; replace an inspection's cached set only when all of
 * it arrived and passed the checks, in one transaction; then the global reads the same way.
 *
 * It deletes nothing but the rows it replaces. An inspection that falls out of the list is not purged here: whether
 * a package still belongs on the device is decided by the server's visibility answer, not by a list window.
 */

export type RefreshReason = 'start' | 'online' | 'foreground' | 'unlocked' | 'manual' | 'sign_in' | 'fallback';

/** Why a run stopped before it finished. `upgrade_required` is the server refusing this app version for these reads. */
export type RefreshHalt =
  | 'auth'
  | 'upgrade_required'
  | 'locked'
  | 'offline'
  | 'lease_lost'
  | 'no_account'
  | 'stopped'
  | 'request_cap'
  | 'too_many_errors'
  | 'rate_limited'
  | 'list_failed'
  | 'storage_failed';

export interface RefreshSummary {
  /** Inspections whose cached set was replaced. */
  refreshed: number;
  /** Not downloaded: fresh enough, owned by someone else, or replaced or purged by another flow while this one fetched. */
  skipped: number;
  /** Inspections the server answered 403 or 404 for on the inspection itself: skipped quietly, not counted as failures. */
  notVisible: number;
  /** Inspections whose download failed and whose previous cache was kept. Counts only; the codes are in `readPackageStates`. */
  failed: number;
  /** List rows whose id could not safely be put in a path. */
  invalidIds: number;
  requests: number;
  globalRefreshed: boolean;
  halted: RefreshHalt | null;
  /** Another flow (replay, reconcile, another refresh) held the lease; nothing was requested. */
  leaseBusy: boolean;
  /** List queries that stopped at the page cap while the server still had more. Rows past the cap were never seen. */
  listTruncated: number;
  /** Inspections not downloaded because the account is over its cache cap and had nothing evictable (new downloads only). */
  skippedCacheFull: number;
  /** The account was over its cache cap with nothing evictable: only replacements that do not grow the cache were made. */
  cacheFull: boolean;
}

export interface RefreshLimits {
  maxRequests: number;
  maxConsecutiveErrors: number;
  /** Tries per resource for 429, 5xx and network errors. */
  maxAttempts: number;
  /** The longest a single wait inside a run lasts; a Retry-After beyond it stops the run instead. */
  maxWaitMs: number;
  resourceBytes: number;
  inspectionBytes: number;
  cacheCapBytes: number;
  /** An inspection refreshed more recently than this is not downloaded again unless a person asked. */
  freshnessMs: number;
  /** A background run (any reason but `manual`) within this long after a completed list cycle does nothing: the list was just read. */
  listDebounceMs: number;
  listPageSize: number;
  maxListPages: number;
  maxDepth: number;
  maxNodes: number;
  maxArrayLength: number;
}

export const DEFAULT_REFRESH_LIMITS: RefreshLimits = {
  maxRequests: 400,
  maxConsecutiveErrors: 5,
  maxAttempts: 3,
  maxWaitMs: 30_000,
  resourceBytes: 2 * 1024 * 1024,
  inspectionBytes: 8 * 1024 * 1024,
  cacheCapBytes: 200 * 1024 * 1024,
  freshnessMs: 300_000,
  listDebounceMs: 30_000,
  listPageSize: 100,
  maxListPages: 10,
  ...DEFAULT_JSON_LIMITS,
};

/** Requests in flight at once, for the whole run. The engine's free tier is the reason; a caller cannot raise it. */
export const MAX_CONCURRENCY = 3;
export const DEFAULT_FALLBACK_INTERVAL_MS = 600_000;
const MIN_WAIT_MS = 1000;
const LEASE_BUSY_RETRY_BASE_MS = 2000;
const LEASE_BUSY_RETRY_SPAN_MS = 3000;
const LEASE_BUSY_RETRIES_BEFORE_FALLBACK = 10;
const MAX_CURSOR_LENGTH = 512;
const CURSOR_PATTERN = /^[A-Za-z0-9+/=_-]+$/;
const MAX_ETAG_LENGTH = 256;

export interface RefresherDeps {
  db: Db;
  /** The authenticated wrapper: every call goes to the pinned origin, never follows a redirect, and caps the body. */
  http: Http;
  tokens: Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  /** The stored, canonical server origin. */
  origin: string;
  clientHeaders?: Record<string, string>;
  allowInsecureHttp?: boolean;
  /** The signed-in account, or null. Read before every request. */
  account(): Account | null | Promise<Account | null>;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  onUnlocked?: (listener: () => void) => () => void;
  network: Pick<Network, 'online' | 'onChange'>;
  appState?: AppStatePort;
  clock: Clock;
  timers?: TimerPort;
  random?: () => number;
  fallbackIntervalMs?: number;
  leaseTtlMs?: number;
  /** A fresh lease token per acquisition. Tests only. */
  newToken?: () => string;
  concurrency?: number;
  limits?: Partial<RefreshLimits>;
  /** A run stopped for a reason the person may need to act on (sign in again, update the app). */
  onHalt?: (reason: RefreshHalt) => void;
  /** Every finished flight's last summary, whatever its outcome (the caller decides what counts as a success). A throw is ignored. */
  onSummary?: (summary: RefreshSummary) => void;
  /** Receives storage failures. Never receives a token, a url, a body or any server text. */
  onError?: (error: unknown) => void;
}

export interface WorkPackageRefresher {
  /** One run. Concurrent calls share it. A person asking (`manual`) re-downloads even what is fresh. */
  refresh(options?: { reason?: RefreshReason }): Promise<RefreshSummary>;
  /** `refresh` for an event: a trigger during a run makes one more run after it. */
  trigger(reason?: RefreshReason): void;
  /** Runs now, then on the network coming back, on the app coming to the front, on unlock, and on a slow timer. */
  start(): void;
  /** Terminal: no further request, no timer, no subscription. */
  stop(): void;
  idle(): Promise<void>;
  /**
   * Re-downloads the reads of ONE inspection, through the same guards as a full run (lock, network, account, lease, the
   * package's own refreshable/visible/blocked checks). For after a write: the cache then shows what the write changed.
   * Never rejects. It does not list, does not touch other inspections and does not run the globals.
   */
  refreshInspection(inspectionId: string): Promise<InspectionRefresh>;
}

export type InspectionRefresh =
  | { kind: 'refreshed' }
  /** Nothing was replaced: not refreshable (blocked, quarantined, another account, unconfirmed), a stale generation, or an invalid id. */
  | { kind: 'skipped' }
  /** The inspection is no longer visible or its download failed; the cache was not changed. */
  | { kind: 'failed' }
  /** Another flow holds the lease; nothing was requested. */
  | { kind: 'busy' }
  | { kind: 'halted'; reason: RefreshHalt };

type Fetched =
  | { kind: 'ok'; text: string; json: unknown; etag: string | null }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'fail'; code: RefreshErrorCode }
  | { kind: 'cancelled' }
  | { kind: 'halt' };

type Sent = { kind: 'response'; res: HttpResponse } | { kind: 'transport'; code: RefreshErrorCode } | { kind: 'halt' };

interface Run {
  account: Account;
  key: string;
  lease: LeaseHandle;
  reason: RefreshReason;
  summary: RefreshSummary;
  consecutive: number;
  halted: RefreshHalt | null;
  cooling: Promise<void> | null;
  /** Inspections this run already found not visible: never asked about again in the same run. */
  hidden: Set<string>;
  /** Set when the account is over its cache cap and eviction could not get it under: replacements may not grow the cache. */
  replaceOnly: boolean;
  /** Growth already granted to replacements of this run while in `replaceOnly` mode. */
  granted: number;
}

const emptySummary = (): RefreshSummary => ({ refreshed: 0, skipped: 0, notVisible: 0, failed: 0, invalidIds: 0, requests: 0, globalRefreshed: false, halted: null, leaseBusy: false, listTruncated: 0, skippedCacheFull: 0, cacheFull: false });

const utf8Length = (text: string): number => new TextEncoder().encode(text).byteLength;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function createWorkPackageRefresher(deps: RefresherDeps): WorkPackageRefresher {
  // Every url is built from this string, so it must be exactly what the server screen stored: an origin and nothing else.
  if (parseServerUrl(deps.origin, deps.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: deps.allowInsecureHttp }) !== deps.origin) throw new AuthError('invalid_server_url');
  const limits: RefreshLimits = { ...DEFAULT_REFRESH_LIMITS, ...deps.limits };
  const jsonLimits: JsonLimits = { maxDepth: limits.maxDepth, maxNodes: limits.maxNodes, maxArrayLength: limits.maxArrayLength };
  const concurrency = Math.max(1, Math.min(Math.trunc(deps.concurrency ?? MAX_CONCURRENCY), MAX_CONCURRENCY));
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const clientHeaders = safeClientHeaders(deps.clientHeaders ?? {}, ['accept', 'if-none-match', 'if-match']);
  const fallbackInterval = Math.max(MIN_WAIT_MS, deps.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS);
  const leaseOptions = { clock: deps.clock, ttlMs: deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, ...(deps.newToken ? { newToken: deps.newToken } : {}) };
  let stopped = false;
  let started = false;
  let running: Promise<RefreshSummary> | null = null;
  let queued: RefreshReason | null = null;
  let runningReason: RefreshReason | null = null;
  let busyStreak = 0;
  /** When the list queries of a run last all completed, and for whom. */
  let lastListed: { key: string; at: number } | null = null;
  let timer: unknown = null;
  const unsubscribe: (() => void)[] = [];
  const sleepers = new Set<() => void>();
  const permits: (() => void)[] = [];
  let inFlight = 0;

  function report(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // A failing reporter must not change what the run does.
    }
  }

  function notify(call: () => void): void {
    try {
      call();
    } catch {
      // A failing listener must not change what the run does.
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        sleepers.delete(wake);
        timers.clearTimeout(handle);
        resolve();
      };
      const handle = timers.setTimeout(wake, ms);
      sleepers.add(wake);
    });
  }

  async function acquirePermit(): Promise<() => void> {
    if (inFlight >= concurrency) await new Promise<void>((resolve) => permits.push(resolve));
    else inFlight += 1;
    return () => {
      const next = permits.shift();
      if (next) next();
      else inFlight -= 1;
    };
  }

  async function currentAccount(): Promise<Account | null> {
    try {
      return await deps.account();
    } catch {
      return null;
    }
  }

  /** The part of the gate that needs no lease: checked before the lease is taken, and again by `gate`. */
  async function mayContactServer(needNetwork: boolean): Promise<RefreshHalt | null> {
    if (stopped) return 'stopped';
    try {
      if (await deps.isLocked()) return 'locked';
    } catch {
      return 'locked';
    }
    if (stopped) return 'stopped';
    if (needNetwork) {
      try {
        if (!(await deps.network.online())) return 'offline';
      } catch {
        return 'offline';
      }
    }
    return stopped ? 'stopped' : null;
  }

  /** Checked right before every request and every write: the lock, the network (requests only), the account and the lease. */
  async function gate(run: Run, forRequest: boolean): Promise<RefreshHalt | null> {
    const blocked = await mayContactServer(forRequest);
    if (blocked !== null) return blocked;
    const who = await currentAccount();
    if (who === null || !sameAccount(who, run.account.tenantId, run.account.userId)) return 'no_account';
    if (!(await run.lease.renew().catch(() => false))) return 'lease_lost';
    return stopped ? 'stopped' : null;
  }

  function halt(run: Run, reason: RefreshHalt): { kind: 'halt' } {
    run.halted ??= reason;
    return { kind: 'halt' };
  }

  async function sendOnce(run: Run, path: string): Promise<Sent> {
    // A request may have waited for a permit since `getJson` last looked: a stopped refresher fetches no token at all.
    if (stopped) return halt(run, 'stopped');
    let token: string | null;
    try {
      token = await deps.tokens.getAccessToken(deps.origin);
    } catch {
      return { kind: 'transport', code: 'network' };
    }
    if (token === null) return halt(run, 'auth');
    // Fetching a token can take a refresh round trip; what was true before it is checked again right before the request.
    if (stopped) return halt(run, 'stopped');
    const blocked = await gate(run, true);
    if (blocked !== null) return halt(run, blocked);
    if (run.summary.requests >= limits.maxRequests) return halt(run, 'request_cap');
    run.summary.requests += 1;
    try {
      const res = await deps.http.request({
        url: `${deps.origin}${path}`,
        method: 'GET',
        headers: { ...clientHeaders, Accept: 'application/json', Authorization: `Bearer ${token}` },
        maxBytes: limits.resourceBytes,
      });
      return { kind: 'response', res };
    } catch (error) {
      if (error instanceof AuthError && error.code === 'server_response_invalid') return { kind: 'transport', code: 'too_large' };
      if (error instanceof AuthError && error.code === 'server_redirected') return { kind: 'transport', code: 'invalid_response' };
      return { kind: 'transport', code: 'network' };
    }
  }

  /** A 2xx that is not the server's JSON envelope is never stored. */
  function judge(res: HttpResponse): Fetched {
    if (res.headers.get('set-cookie') !== null) return { kind: 'fail', code: 'invalid_response' };
    if (!isJsonContentType(res.headers)) return { kind: 'fail', code: 'invalid_response' };
    if (res.text.length > limits.resourceBytes) return { kind: 'fail', code: 'too_large' };
    if (!hasSuccessEnvelope(res.json)) return { kind: 'fail', code: 'invalid_response' };
    if (!jsonWithinLimits(res.json, jsonLimits)) return { kind: 'fail', code: 'invalid_response' };
    const etag = res.headers.get('etag');
    return { kind: 'ok', text: res.text, json: res.json, etag: etag !== null && etag.length <= MAX_ETAG_LENGTH ? etag : null };
  }

  /** One GET with its retries. Answers; never throws. `skip` lets a sibling failure cancel requests that have not been sent. */
  async function getJson(run: Run, path: string, skip?: () => boolean): Promise<Fetched> {
    let attempt = 0;
    let reauthed = false;
    for (;;) {
      if (stopped) return halt(run, 'stopped');
      if (run.halted !== null) return { kind: 'halt' };
      if (skip?.()) return { kind: 'cancelled' };
      if (run.cooling !== null) {
        await run.cooling;
        continue;
      }
      const release = await acquirePermit();
      if (stopped || run.halted !== null || skip?.()) {
        // Waiting for a permit can outlast the reason to send: a sibling failed, the run halted or the refresher stopped.
        release();
        continue;
      }
      let sent: Sent;
      try {
        sent = await sendOnce(run, path);
      } finally {
        release();
      }
      if (sent.kind === 'halt') return sent;
      let code: RefreshErrorCode;
      let retryAfterMs: number | null = null;
      if (sent.kind === 'transport') {
        if (sent.code !== 'network') return { kind: 'fail', code: sent.code };
        code = 'network';
      } else {
        const { res } = sent;
        if (res.status === 401) {
          if (reauthed) return halt(run, 'auth');
          reauthed = true;
          try {
            const check = await deps.tokens.checkSession(deps.origin);
            if (check.kind === 'relogin' || check.kind === 'signed_out') return halt(run, 'auth');
            if (check.kind === 'retry') {
              code = 'network';
              retryAfterMs = check.retryAfterMs;
            } else {
              continue;
            }
          } catch {
            code = 'network';
          }
        } else if (res.status === 426) {
          return halt(run, 'upgrade_required');
        } else if (res.status === 429) {
          code = 'rate_limited';
          retryAfterMs = res.retryAfterMs;
        } else if (res.status === 408 || res.status >= 500) {
          code = 'server_error';
          retryAfterMs = res.retryAfterMs;
        } else if (res.status === 404) {
          run.consecutive = 0;
          return { kind: 'missing' };
        } else if (res.status === 403) {
          run.consecutive = 0;
          return { kind: 'forbidden' };
        } else if (res.status >= 400 && res.status < 500) {
          run.consecutive = 0;
          return { kind: 'fail', code: 'refused' };
        } else if (res.status >= 200 && res.status < 300) {
          run.consecutive = 0;
          return judge(res);
        } else {
          return { kind: 'fail', code: 'invalid_response' };
        }
      }
      // Transient: 429, 5xx, a network error, a session check that asked to try again.
      run.consecutive += 1;
      if (run.consecutive >= limits.maxConsecutiveErrors) return halt(run, 'too_many_errors');
      if (code === 'rate_limited' && retryAfterMs !== null && retryAfterMs > limits.maxWaitMs) return halt(run, 'rate_limited');
      attempt += 1;
      if (attempt >= limits.maxAttempts) return { kind: 'fail', code };
      const wanted = retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : backoffMs(attempt, null, random);
      const wait = Math.min(Math.max(wanted, MIN_WAIT_MS), limits.maxWaitMs);
      if (code === 'rate_limited') {
        // One wait for everybody: the server asked for quiet, and every other request holds back for it too.
        run.cooling ??= sleep(wait).finally(() => {
          run.cooling = null;
        });
        await run.cooling;
      } else {
        await sleep(wait);
      }
    }
  }

  async function fail(run: Run, id: string, code: RefreshErrorCode): Promise<void> {
    run.summary.failed += 1;
    if ((await gate(run, false)) !== null) return;
    try {
      await recordRefreshError(deps.db, { accountKey: run.key, inspectionId: id, code, at: deps.clock.now() });
    } catch (error) {
      report(error);
    }
  }

  /** The server does not show this inspection to this person: a quiet marker, not a failure, and not an error for the halt rule. */
  async function notVisible(run: Run, id: string): Promise<void> {
    run.summary.notVisible += 1;
    run.hidden.add(id);
    if ((await gate(run, false)) !== null) return;
    try {
      await recordRefreshError(deps.db, { accountKey: run.key, inspectionId: id, code: 'not_visible', at: deps.clock.now() });
    } catch (error) {
      report(error);
    }
  }

  function stage(into: Map<string, StagedResource>, path: string, fetched: Extract<Fetched, { kind: 'ok' }>, now: number): void {
    into.set(path, { body: fetched.text, etag: fetched.etag, fetchedAt: now });
  }

  /**
   * In `replaceOnly` mode (the account is over its cap with nothing to evict): true when replacing a package's set of
   * `newBytes` does not push the account past the cap. A set that is no bigger than the one it replaces always passes.
   * Growth is granted against the headroom minus what this run already granted, and a grant is never given back, so
   * three replacements racing each other can only be refused too often, never accepted too often.
   */
  async function mayGrow(run: Run, packageId: string, newBytes: number): Promise<boolean> {
    const held = await packageBytes(deps.db, run.key, packageId);
    const growth = newBytes - held;
    if (growth <= 0) return true;
    const total = await cacheBytes(deps.db, run.key);
    if (growth > limits.cacheCapBytes - total - run.granted) return false;
    run.granted += growth;
    return true;
  }

  async function refreshOne(run: Run, target: Target): Promise<void> {
    const before = await readPackageRow(deps.db, target.id);
    if (before === null || !isRefreshable(before, run.account) || run.hidden.has(target.id)) {
      run.summary.skipped += 1;
      return;
    }
    const staged = new Map<string, StagedResource>();
    const now = deps.clock.now();
    let cancelled = false;
    const skip = (): boolean => cancelled || run.halted !== null;
    const [rowPath, ...otherBase] = baseInspectionPaths(target.id);
    if (rowPath === undefined) return;
    const row = await getJson(run, rowPath, skip);
    if (row.kind === 'halt' || row.kind === 'cancelled') return;
    if (row.kind === 'missing' || row.kind === 'forbidden') return notVisible(run, target.id);
    if (row.kind === 'fail') return fail(run, target.id, row.code);
    const inspection = asRecord(asRecord(asRecord(row.json)?.data)?.inspection);
    if (inspection === null || inspection.id !== target.id) return fail(run, target.id, 'invalid_response');
    stage(staged, rowPath, row, now);
    const wanted = [...otherBase.map((path) => ({ path, optional: false })), ...conditionalInspectionPaths(target.id, row.json).map((path) => ({ path, optional: true }))];
    const answers = await Promise.all(
      wanted.map(async (item) => {
        const answer = await getJson(run, item.path, skip);
        if (answer.kind !== 'ok' && !(answer.kind === 'missing' && item.optional)) cancelled = true;
        return { ...item, answer };
      }),
    );
    if (run.halted !== null) return;
    let failure: RefreshErrorCode | null = null;
    for (const { path, optional, answer } of answers) {
      if (answer.kind === 'ok') stage(staged, path, answer, now);
      else if (answer.kind === 'missing' && !optional) failure ??= 'not_found';
      else if (answer.kind === 'fail') failure ??= answer.code;
      else if (answer.kind === 'forbidden') failure ??= 'refused';
    }
    if (failure !== null) return fail(run, target.id, failure);
    let bytes = 0;
    for (const value of staged.values()) bytes += utf8Length(value.body);
    if (bytes > limits.inspectionBytes) return fail(run, target.id, 'too_large');
    if (run.replaceOnly && !(await mayGrow(run, target.id, bytes))) {
      run.summary.skippedCacheFull += 1;
      return;
    }
    const blocked = await gate(run, false);
    if (blocked !== null) {
      halt(run, blocked);
      return;
    }
    try {
      const outcome = await replaceInspectionResources(deps.db, { accountKey: run.key, inspectionId: target.id, packageGen: before.package_gen, resources: staged, refreshedAt: deps.clock.now() });
      if (outcome === 'replaced') run.summary.refreshed += 1;
      else run.summary.skipped += 1;
    } catch (error) {
      report(error);
      await fail(run, target.id, 'storage_failed');
    }
  }

  /** The rows of one list query, all pages. Null when the list could not be read (the run is then halted). */
  async function readList(run: Run, params: Record<string, string>, into: ParsedList, todayDay: string): Promise<boolean> {
    let cursor: string | null = null;
    for (let page = 0; page < limits.maxListPages; page += 1) {
      const query = Object.entries({ limit: String(limits.listPageSize), ...params, ...(cursor === null ? {} : { cursor }) })
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('&');
      const got = await getJson(run, `/api/inspections?${query}`);
      if (got.kind === 'halt') return false;
      const body = got.kind === 'ok' ? asRecord(got.json) : null;
      if (got.kind !== 'ok' || body === null || !Array.isArray(body.data)) {
        halt(run, 'list_failed');
        return false;
      }
      addListRows(into, body.data as unknown[], todayDay);
      const next = asRecord(body.meta)?.nextCursor;
      if (next === null || next === undefined) return true;
      if (typeof next !== 'string' || next.length === 0 || next.length > MAX_CURSOR_LENGTH || !CURSOR_PATTERN.test(next)) {
        halt(run, 'list_failed');
        return false;
      }
      cursor = next;
    }
    // The cap was reached with a cursor still open: what lies past it was never seen, and the summary says so.
    run.summary.listTruncated += 1;
    return true;
  }

  async function refreshGlobals(run: Run): Promise<void> {
    if (run.reason !== 'manual') {
      const known = await readCached(deps.db, run.key, '/api/tags');
      const age = known === null ? Number.POSITIVE_INFINITY : deps.clock.now() - known.fetchedAt;
      if (age >= 0 && age < limits.freshnessMs) return;
    }
    let cancelled = false;
    const now = deps.clock.now();
    const answers = await Promise.all(
      GLOBAL_RESOURCE_PATHS.map(async (path) => {
        const answer = await getJson(run, path, () => cancelled || run.halted !== null);
        if (answer.kind !== 'ok') cancelled = true;
        return { path, answer };
      }),
    );
    if (run.halted !== null) return;
    const staged = new Map<string, StagedResource>();
    let stagedBytes = 0;
    for (const { path, answer } of answers) {
      if (answer.kind !== 'ok') return;
      stage(staged, path, answer, now);
      stagedBytes += utf8Length(answer.text);
    }
    if (run.replaceOnly && !(await mayGrow(run, GLOBAL_PACKAGE_ID, stagedBytes))) return;
    const blocked = await gate(run, false);
    if (blocked !== null) {
      halt(run, blocked);
      return;
    }
    try {
      await replaceGlobalResources(deps.db, { accountKey: run.key, resources: staged });
      run.summary.globalRefreshed = true;
    } catch (error) {
      report(error);
    }
  }

  async function evict(run: Run): Promise<number> {
    const result = await evictOverCap(deps.db, { accountKey: run.key, capBytes: limits.cacheCapBytes });
    return result.bytes;
  }

  async function work(run: Run): Promise<void> {
    if ((await evict(run)) > limits.cacheCapBytes) {
      // Over the cap with nothing left to evict (pinned, unsent or unconfirmed packages hold the space). Stopping here
      // would keep even today's work from refreshing, so the run goes on in replace-only mode instead.
      run.replaceOnly = true;
      run.summary.cacheFull = true;
    }
    const now = deps.clock.now();
    const todayDay = utcDay(now);
    const days = await readSyncDays(deps.db);
    const list = newParsedList();
    const queries: Record<string, string>[] = [
      { inspectorId: run.account.userId, ...windowFor(now, days) },
      ...(['requested', 'scheduled', 'confirmed'] as const).map((status) => ({ inspectorId: run.account.userId, status })),
    ];
    for (const params of queries) {
      if (!(await readList(run, params, list, todayDay))) return;
    }
    lastListed = { key: run.key, at: deps.clock.now() };
    run.summary.invalidIds = list.invalid.size + list.invalidAnonymous;
    const blocked = await gate(run, false);
    if (blocked !== null) {
      halt(run, blocked);
      return;
    }
    await upsertListed(deps.db, run.account, list.items);
    const rows = await readPackageRows(deps.db);
    const withError = await packagesWithError(deps.db, run.account);
    const hiddenAt = await notVisibleMarkers(deps.db, run.account);
    const held = run.replaceOnly ? await packagesWithCachedRows(deps.db, run.key) : new Set<string>();
    const targets: Target[] = [];
    const considered = new Set<string>();
    const consider = (id: string, listed: { scheduledAt: number | null; completed: boolean; today: boolean } | null): void => {
      considered.add(id);
      const row = rows.get(id);
      if (row === undefined || !isRefreshable(row, run.account)) {
        run.summary.skipped += 1;
        return;
      }
      const hiddenFor = now - (hiddenAt.get(id) ?? Number.NEGATIVE_INFINITY);
      if (run.reason !== 'manual' && hiddenFor >= 0 && hiddenFor < limits.freshnessMs) {
        run.summary.skipped += 1;
        return;
      }
      const age = now - row.refreshed_at;
      const fresh = run.reason !== 'manual' && row.refreshed_at > 0 && age >= 0 && age < limits.freshnessMs && !withError.has(id);
      if (fresh) {
        run.summary.skipped += 1;
        return;
      }
      if (run.replaceOnly && !held.has(id)) {
        run.summary.skippedCacheFull += 1;
        return;
      }
      const scheduledAt = listed === null ? row.scheduled_at : listed.scheduledAt;
      const today = listed?.today ?? (scheduledAt !== null && utcDay(scheduledAt) === todayDay);
      targets.push({ id, scheduledAt, completed: listed?.completed ?? false, pinned: row.pinned === 1, today, listed: listed !== null });
    };
    for (const [id, item] of list.items) consider(id, item);
    for (const [id, row] of rows) {
      if (row.pinned === 1 && !considered.has(id)) consider(id, null);
    }
    const queue = orderTargets(targets);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (run.halted !== null) return;
        const target = queue[next];
        next += 1;
        if (target === undefined) return;
        await refreshOne(run, target);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (run.halted === null) await refreshGlobals(run);
    if (run.halted === null && (await gate(run, false)) === null) await evict(run);
  }

  async function runOnce(reason: RefreshReason): Promise<RefreshSummary> {
    const summary = emptySummary();
    const blocked = await mayContactServer(true);
    if (blocked !== null) {
      summary.halted = blocked;
      return summary;
    }
    const account = await currentAccount();
    if (account === null) {
      summary.halted = 'no_account';
      return summary;
    }
    const key = accountKeyOf(account);
    // Two triggers a moment apart (the network coming back and the app coming to the front) are one cycle: the list was just read.
    if (reason !== 'manual' && lastListed !== null && lastListed.key === key) {
      const since = deps.clock.now() - lastListed.at;
      if (since >= 0 && since < limits.listDebounceMs) return summary;
    }
    const run: Omit<Run, 'lease'> = { account, key, reason, summary, consecutive: 0, halted: null, cooling: null, hidden: new Set<string>(), replaceOnly: false, granted: 0 };
    try {
      const outcome = await withLease(deps.db, SYNC_LEASE, leaseOptions, async (lease) => {
        const live: Run = { ...run, lease };
        try {
          await work(live);
        } finally {
          summary.halted = live.halted;
        }
      });
      if (!outcome.acquired) summary.leaseBusy = true;
    } catch (error) {
      report(error);
      summary.halted ??= 'storage_failed';
    }
    return summary;
  }

  async function refreshInspection(inspectionId: string): Promise<InspectionRefresh> {
    if (!isLocalId(inspectionId)) return { kind: 'skipped' };
    const blocked = await mayContactServer(true);
    if (blocked !== null) return { kind: 'halted', reason: blocked };
    const account = await currentAccount();
    if (account === null) return { kind: 'halted', reason: 'no_account' };
    const summary = emptySummary();
    const base: Omit<Run, 'lease'> = { account, key: accountKeyOf(account), reason: 'manual', summary, consecutive: 0, halted: null, cooling: null, hidden: new Set<string>(), replaceOnly: false, granted: 0 };
    try {
      const outcome = await withLease(deps.db, SYNC_LEASE, leaseOptions, async (lease) => {
        const live: Run = { ...base, lease };
        try {
          await refreshOne(live, { id: inspectionId, scheduledAt: null, completed: false, pinned: false, today: false, listed: false });
        } finally {
          summary.halted = live.halted;
        }
      });
      if (!outcome.acquired) return { kind: 'busy' };
    } catch (error) {
      report(error);
      return { kind: 'failed' };
    }
    if (summary.halted !== null) return { kind: 'halted', reason: summary.halted };
    if (summary.refreshed > 0) return { kind: 'refreshed' };
    return summary.failed > 0 || summary.notVisible > 0 ? { kind: 'failed' } : { kind: 'skipped' };
  }

  function fallbackDelay(): number {
    return Math.round(fallbackInterval * (0.75 + 0.5 * random()));
  }

  function leaseBusyDelay(): number {
    return Math.round(LEASE_BUSY_RETRY_BASE_MS + LEASE_BUSY_RETRY_SPAN_MS * random());
  }

  function scheduleNext(summary: RefreshSummary): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    const onlyBusy = summary.leaseBusy && summary.halted === null;
    busyStreak = onlyBusy ? busyStreak + 1 : 0;
    if (stopped || !started) return;
    const delay = onlyBusy && busyStreak <= LEASE_BUSY_RETRIES_BEFORE_FALLBACK ? leaseBusyDelay() : fallbackDelay();
    timer = timers.setTimeout(() => {
      timer = null;
      trigger('fallback');
    }, delay);
  }

  function takeQueued(): RefreshReason | null {
    const reason = queued;
    queued = null;
    return reason;
  }

  /**
   * A call while a run is in flight shares that run, with one exception: a person asking (`manual`) while a run for
   * another reason is going must not be answered with that run's result, whose freshness skips a person's request
   * overrides. It queues one more manual run, and the promise it gets resolves with the summary of that follow-up run
   * (the last run of the flight). Any other reason during a run just shares the flight and queues nothing.
   */
  function refresh(options: { reason?: RefreshReason } = {}): Promise<RefreshSummary> {
    if (running !== null) {
      if ((options.reason ?? 'manual') === 'manual' && !stopped && runningReason !== 'manual') queued = 'manual';
      return running;
    }
    const flight: Promise<RefreshSummary> = (async (): Promise<RefreshSummary> => {
      let reason: RefreshReason = options.reason ?? 'manual';
      let last: RefreshSummary;
      for (;;) {
        runningReason = reason;
        last = await runOnce(reason);
        const follow = takeQueued();
        if (follow === null || stopped) break;
        reason = follow;
      }
      // Cleared in the same turn as the last look at `queued`, so a call that arrives after it starts a new flight
      // instead of queueing a run nobody would take.
      running = null;
      if (last.halted === 'auth' || last.halted === 'upgrade_required') {
        const why = last.halted;
        notify(() => deps.onHalt?.(why));
      }
      const finished = last;
      notify(() => deps.onSummary?.(finished));
      scheduleNext(last);
      return last;
    })().finally(() => {
      if (running === flight) running = null;
    });
    running = flight;
    return flight;
  }

  function trigger(reason: RefreshReason = 'manual'): void {
    if (stopped) return;
    if (running !== null) {
      queued = queued === 'manual' ? 'manual' : reason;
      return;
    }
    refresh({ reason }).catch(report);
  }

  return {
    refresh,
    trigger,
    refreshInspection,
    start: () => {
      if (started || stopped) return;
      started = true;
      unsubscribe.push(
        deps.network.onChange((online) => {
          if (online) trigger('online');
        }),
      );
      if (deps.appState) {
        unsubscribe.push(
          deps.appState.onChange((active) => {
            if (active) trigger('foreground');
          }),
        );
      }
      if (deps.onUnlocked) unsubscribe.push(deps.onUnlocked(() => trigger('unlocked')));
      trigger('start');
    },
    stop: () => {
      stopped = true;
      for (const off of unsubscribe.splice(0)) off();
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      for (const wake of [...sleepers]) wake();
    },
    idle: async () => {
      while (running !== null) await running.catch(() => undefined);
    },
  };
}
