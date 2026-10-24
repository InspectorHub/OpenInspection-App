import { backoffMs, type TokenManager } from '../auth/tokens';
import type { Http, HttpResponse } from '../auth/http';
import { realTimers, type TimerPort } from '../collab/timers';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Network } from '../platform/network';
import type { OutboxErrorCode } from '../platform/schema';
import { DEFAULT_LEASE_TTL_MS, SYNC_LEASE, withLease, type LeaseHandle } from './lease';
import type { AppStatePort } from './lock-monitor';
import {
  completeRow,
  discardRow,
  markFailed,
  markWaiting,
  readOutboxRow,
  retryRow,
  sameAccount,
  type Account,
  type OutboxRow,
} from './outbox';
import { DEFAULT_REGISTRY, findCommand, isLocalId, pathFor, type CommandDef, type CommandRegistry } from './registry';

/** Why a run stopped before it reached the end of the queue. */
export type HaltReason = 'auth' | 'upgrade' | 'locked' | 'offline' | 'lease_lost' | 'no_account' | 'stopped';

export interface ReplayResult {
  /** Rows the server accepted (and that were deleted). */
  sent: number;
  /** Rows that became `failed` in this run. */
  failed: number;
  /** Rows left waiting after a transient answer. */
  waiting: number;
  halted: HaltReason | null;
  /** Another flow (reconcile, refresh, another replayer) held the lease; nothing was sent. */
  leaseBusy: boolean;
}

export interface ReplayProgress {
  sent: number;
  failed: number;
  waiting: number;
}

export const DEFAULT_FALLBACK_INTERVAL_MS = 300_000;
export const MIN_RETRY_DELAY_MS = 1000;
export const MAX_RETRY_DELAY_MS = 86_400_000;
/** The longest a server-given Retry-After is honoured. */
export const MAX_RETRY_AFTER_MS = 3_600_000;
/** First wait after a 403/404 on an inspection-bound write; doubles up to an hour. A still-visible inspection is asked again slowly, never abandoned. */
export const TARGET_CHECK_BASE_MS = 30_000;
export const IN_FLIGHT_RETRY_MS = 2000;
/** Answers the replay reads are small JSON envelopes; a larger one is not the server's. */
export const RESPONSE_MAX_BYTES = 262_144;
const HEADS_PER_PASS = 200;
/** A `next_at` further ahead than any wait this module writes can only come from a clock that was set back since: the row is due. */
const IMPLAUSIBLE_WAIT_MS = 2 * MAX_RETRY_AFTER_MS;
const QUOTA_CODE = /^QUOTA_/;
const ERROR_CODE = /^[A-Z0-9_]{1,64}$/;

export interface ReplayDeps {
  db: Db;
  /** The authenticated wrapper: every call goes to the pinned origin and never follows a redirect. */
  http: Http;
  tokens: Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  /** The stored, canonical server origin. Every url is this plus a registry route. */
  origin: string;
  registry?: CommandRegistry;
  /** `X-Client-Platform` and `X-Client-Version`. */
  clientHeaders?: Record<string, string>;
  /** The signed-in account, or null when there is none. Read before every request. */
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
  /** The server could not see the target inspection (403/404): ask the server whether it is still visible. Once per inspection per run. */
  onNeedsReconcile?: (inspectionId: string) => void;
  /** A run stopped early for a reason the person may need to act on (sign in again, update the app). */
  onHalt?: (reason: HaltReason) => void;
  onProgress?: (progress: ReplayProgress) => void;
  /** Receives storage failures. Never receives a token, a url, a payload or any server text. */
  onError?: (error: unknown) => void;
}

export interface Replayer {
  /** One run over the queue. Concurrent calls share one run. Sends nothing while locked, revoked, offline, signed out or stopped. */
  replay(): Promise<ReplayResult>;
  /** `replay()` for an event: a trigger during a run makes one more run after it. Call it right after an enqueue. */
  trigger(): void;
  /** Runs now, then on the network coming back, on returning to the foreground, on unlock, and when something is due. */
  start(): void;
  /** Terminal: no further request, no timer, no subscription. */
  stop(): void;
  idle(): Promise<void>;
  /** Puts a failed row back in line (or makes a waiting row due now) and runs. */
  retry(idempotencyKey: string): Promise<boolean>;
  /** Deletes a queued write. The caller must have shown the confirmation: `confirmed: true` is that promise. */
  discard(idempotencyKey: string, options: { confirmed: true }): Promise<boolean>;
}

type Decision =
  | { kind: 'sent' }
  | { kind: 'failed'; code: OutboxErrorCode }
  | { kind: 'waiting'; code: OutboxErrorCode; delayMs: number; needsCheck: boolean }
  | { kind: 'halt'; reason: HaltReason };

type Sent = { kind: 'response'; res: HttpResponse } | { kind: 'halt'; reason: HaltReason } | { kind: 'transient'; retryAfterMs: number | null };

interface RunReport {
  result: ReplayResult;
  /** The earliest future instant at which a waiting row becomes due. */
  wake: number | null;
  error: boolean;
}

function errorCodeOf(json: unknown): string | null {
  if (typeof json !== 'object' || json === null || !('error' in json)) return null;
  const error = json.error;
  if (typeof error !== 'object' || error === null || !('code' in error)) return null;
  return typeof error.code === 'string' && ERROR_CODE.test(error.code) ? error.code : null;
}

function isSuccessBody(json: unknown): json is Record<string, unknown> {
  return typeof json === 'object' && json !== null && 'success' in json && json.success === true;
}

/** The inspection the server answered a create with, or null when the body does not say. */
function createdIdOf(json: Record<string, unknown>): string | null {
  const data = json.data;
  if (typeof data !== 'object' || data === null || !('inspection' in data)) return null;
  const inspection = data.inspection;
  if (typeof inspection !== 'object' || inspection === null || !('id' in inspection)) return null;
  return typeof inspection.id === 'string' ? inspection.id : null;
}

export function createReplayer(deps: ReplayDeps): Replayer {
  const registry = deps.registry ?? DEFAULT_REGISTRY;
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const clientHeaders = deps.clientHeaders ?? {};
  const fallbackInterval = Math.max(MIN_RETRY_DELAY_MS, Math.min(deps.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS, MAX_RETRY_DELAY_MS));
  const leaseOptions = { clock: deps.clock, ttlMs: deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, ...(deps.newToken ? { newToken: deps.newToken } : {}) };
  let stopped = false;
  let started = false;
  let running: Promise<ReplayResult> | null = null;
  let again = false;
  let timer: unknown = null;
  const unsubscribe: (() => void)[] = [];

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

  /** The cheap part of the gate, checked again right before a request: the lock can arrive while a token is being fetched. */
  async function mayContactServer(): Promise<HaltReason | null> {
    if (stopped) return 'stopped';
    try {
      if (await deps.isLocked()) return 'locked';
    } catch {
      return 'locked';
    }
    if (stopped) return 'stopped';
    try {
      if (!(await deps.network.online())) return 'offline';
    } catch {
      return 'offline';
    }
    return stopped ? 'stopped' : null;
  }

  async function currentAccount(): Promise<Account | null> {
    try {
      return await deps.account();
    } catch {
      return null;
    }
  }

  function delayFor(row: OutboxRow, retryAfterMs: number | null): number {
    const clamped = retryAfterMs === null ? null : Math.min(Math.max(retryAfterMs, MIN_RETRY_DELAY_MS), MAX_RETRY_AFTER_MS);
    return Math.max(MIN_RETRY_DELAY_MS, backoffMs(row.attempts + 1, clamped, random));
  }

  function targetCheckDelay(row: OutboxRow): number {
    const exponential = Math.min(TARGET_CHECK_BASE_MS * 2 ** Math.min(row.attempts, 10), MAX_RETRY_AFTER_MS);
    return Math.round(exponential * (0.5 + 0.5 * random()));
  }

  /** One authenticated request to the pinned origin. A 401 refreshes the session once; everything else is answered, never thrown. */
  async function send(def: CommandDef, row: OutboxRow, path: string, body: unknown): Promise<Sent> {
    let refreshed = false;
    for (;;) {
      let token: string | null;
      try {
        token = await deps.tokens.getAccessToken(deps.origin);
      } catch {
        return { kind: 'transient', retryAfterMs: null };
      }
      if (token === null) return { kind: 'halt', reason: 'auth' };
      const blocked = await mayContactServer();
      if (blocked !== null) return { kind: 'halt', reason: blocked };
      let res: HttpResponse;
      try {
        res = await deps.http.request({
          url: `${deps.origin}${path}`,
          method: def.method,
          headers: {
            ...clientHeaders,
            Authorization: `Bearer ${token}`,
            'Idempotency-Key': row.idempotencyKey,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          maxBytes: RESPONSE_MAX_BYTES,
        });
      } catch {
        return { kind: 'transient', retryAfterMs: null };
      }
      if (res.status !== 401) return { kind: 'response', res };
      if (refreshed) return { kind: 'halt', reason: 'auth' };
      refreshed = true;
      try {
        const check = await deps.tokens.checkSession(deps.origin);
        if (check.kind === 'relogin' || check.kind === 'signed_out') return { kind: 'halt', reason: 'auth' };
        if (check.kind === 'retry') return { kind: 'transient', retryAfterMs: check.retryAfterMs };
      } catch {
        return { kind: 'transient', retryAfterMs: null };
      }
    }
  }

  /** What an answer means for the row. The status picks the branch; only `error.code` ever refines it, and no server text is kept. */
  function triage(def: CommandDef, row: OutboxRow, res: HttpResponse): Decision {
    const status = res.status;
    const code = errorCodeOf(res.json);
    const waiting = (waitCode: OutboxErrorCode, retryAfterMs: number | null): Decision => ({ kind: 'waiting', code: waitCode, delayMs: delayFor(row, retryAfterMs), needsCheck: false });
    if (status >= 200 && status < 300) {
      // A page that is not the server's (a captive portal answering 200) must never delete a person's write.
      if (!isSuccessBody(res.json)) return waiting('server_error', res.retryAfterMs);
      if (def.createsInspection === true && createdIdOf(res.json) !== row.inspectionId) return { kind: 'failed', code: 'unexpected_response' };
      return { kind: 'sent' };
    }
    if (status === 426) return def.neverBlock ? waiting('server_error', res.retryAfterMs) : { kind: 'halt', reason: 'upgrade' };
    if (status === 429) return waiting('rate_limited', res.retryAfterMs);
    if (status === 409 && code === 'IDEMPOTENCY_IN_FLIGHT') return { kind: 'waiting', code: 'in_flight', delayMs: Math.max(IN_FLIGHT_RETRY_MS, delayFor(row, null)), needsCheck: false };
    if (status >= 400 && status < 500 && code !== null && QUOTA_CODE.test(code)) return { kind: 'failed', code: 'quota_refused' };
    if (status === 409) return { kind: 'failed', code: code === 'ID_CONFLICT' ? 'id_conflict' : 'conflict' };
    if (status === 422) return { kind: 'failed', code: code === 'IDEMPOTENCY_KEY_REUSED' ? 'key_reused' : 'validation_failed' };
    if (status === 400) {
      if (code === 'HOLIDAY_BLOCKED') return { kind: 'failed', code: 'holiday_blocked' };
      return { kind: 'failed', code: def.op === 'inspection.complete' ? 'inspection_cancelled' : 'validation_failed' };
    }
    if ((status === 403 || status === 404) && def.scope === 'inspection' && def.createsInspection !== true) {
      return { kind: 'waiting', code: 'target_not_visible', delayMs: targetCheckDelay(row), needsCheck: true };
    }
    if (status === 408 || status >= 500) return waiting('server_error', res.retryAfterMs);
    if (status >= 400 && status < 500) return { kind: 'failed', code: 'rejected' };
    return waiting('server_error', res.retryAfterMs);
  }

  function fail(code: OutboxErrorCode): Decision {
    return { kind: 'failed', code };
  }

  async function attempt(row: OutboxRow): Promise<Decision> {
    const def = findCommand(registry, row.op);
    if (def === null) return fail('unknown_op');
    if (row.registryVersion !== def.registryVersion) return fail('unknown_registry_version');
    let payload;
    let path: string;
    try {
      payload = def.parse(JSON.parse(row.payload) as unknown);
      const inspectionId = def.inspectionIdOf(payload);
      if (def.scope === 'inspection' && (inspectionId === null || !isLocalId(inspectionId) || inspectionId !== row.inspectionId)) return fail('corrupt_payload');
      path = pathFor(def, inspectionId);
    } catch {
      return fail('corrupt_payload');
    }
    const sent = await send(def, row, path, def.body(payload));
    if (sent.kind === 'halt') return sent;
    if (sent.kind === 'transient') return { kind: 'waiting', code: 'network', delayMs: delayFor(row, sent.retryAfterMs), needsCheck: false };
    return triage(def, row, sent.res);
  }

  async function drain(lease: LeaseHandle, run: RunReport): Promise<void> {
    const { result } = run;
    const attempted = new Set<string>();
    const asked = new Set<string>();
    for (;;) {
      const account = await currentAccount();
      if (account === null) {
        result.halted = 'no_account';
        return;
      }
      // The head of each line: the lowest seq of one account's inspection (or of its inspection-free writes).
      // Only a head may be sent, so a failed, orphaned or waiting head holds back its own line and nothing else.
      const heads = await deps.db.query<{ idempotency_key: string; state: string; next_at: number | null }>(
        `SELECT idempotency_key, state, next_at FROM outbox o
         WHERE tenant_id = ? AND user_id = ?
           AND seq = (SELECT MIN(i.seq) FROM outbox i WHERE i.tenant_id = o.tenant_id AND i.user_id = o.user_id AND COALESCE(i.inspection_id, '') = COALESCE(o.inspection_id, ''))
         ORDER BY seq LIMIT ?`,
        [account.tenantId, account.userId, HEADS_PER_PASS],
      );
      let progressed = false;
      for (const head of heads) {
        if (attempted.has(head.idempotency_key) || head.state !== 'pending') continue;
        if (head.next_at !== null && head.next_at > deps.clock.now() && head.next_at - deps.clock.now() <= IMPLAUSIBLE_WAIT_MS) {
          if (run.wake === null || head.next_at < run.wake) run.wake = head.next_at;
          continue;
        }
        const blocked = await mayContactServer();
        if (blocked !== null) {
          result.halted = blocked;
          return;
        }
        if (!(await lease.renew().catch(() => false))) {
          result.halted = 'lease_lost';
          return;
        }
        const row = await readOutboxRow(deps.db, head.idempotency_key);
        if (row === null || row.state !== 'pending' || !sameAccount(account, row.tenantId, row.userId)) continue;
        // The account could have changed while the previous row was in flight.
        const now = await currentAccount();
        if (now === null || !sameAccount(now, row.tenantId, row.userId)) {
          result.halted = 'no_account';
          return;
        }
        attempted.add(row.idempotencyKey);
        progressed = true;
        const decision = await attempt(row);
        if (decision.kind === 'halt') {
          result.halted = decision.reason;
          return;
        }
        if (decision.kind === 'sent') {
          const def = findCommand(registry, row.op);
          await completeRow(deps.db, row, def?.createsInspection === true);
          result.sent += 1;
        } else if (decision.kind === 'failed') {
          await markFailed(deps.db, row.idempotencyKey, decision.code);
          result.failed += 1;
        } else {
          const nextAt = deps.clock.now() + decision.delayMs;
          await markWaiting(deps.db, row.idempotencyKey, decision.code, nextAt);
          result.waiting += 1;
          if (run.wake === null || nextAt < run.wake) run.wake = nextAt;
          if (decision.needsCheck && row.inspectionId !== null && !asked.has(row.inspectionId)) {
            asked.add(row.inspectionId);
            const target = row.inspectionId;
            notify(() => deps.onNeedsReconcile?.(target));
          }
        }
        const progress = { sent: result.sent, failed: result.failed, waiting: result.waiting };
        notify(() => deps.onProgress?.(progress));
      }
      if (!progressed) return;
    }
  }

  async function runOnce(): Promise<RunReport> {
    const run: RunReport = { result: { sent: 0, failed: 0, waiting: 0, halted: null, leaseBusy: false }, wake: null, error: false };
    const blocked = await mayContactServer();
    if (blocked !== null) {
      run.result.halted = blocked;
      return run;
    }
    try {
      const outcome = await withLease(deps.db, SYNC_LEASE, leaseOptions, (lease) => drain(lease, run));
      if (!outcome.acquired) run.result.leaseBusy = true;
    } catch (error) {
      report(error);
      run.error = true;
    }
    return run;
  }

  function fallbackDelay(): number {
    return Math.round(fallbackInterval * (0.75 + 0.5 * random()));
  }

  function scheduleRetry(run: RunReport): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    if (stopped) return;
    const { halted, leaseBusy } = run.result;
    const stuck = halted !== null || leaseBusy || run.error;
    const candidates: number[] = [];
    if (!stuck && run.wake !== null) candidates.push(run.wake - deps.clock.now());
    if (started && stuck && halted !== 'stopped') candidates.push(fallbackDelay());
    if (candidates.length === 0) return;
    const delay = Math.max(MIN_RETRY_DELAY_MS, Math.min(Math.min(...candidates), MAX_RETRY_DELAY_MS));
    timer = timers.setTimeout(() => {
      timer = null;
      trigger();
    }, delay);
  }

  function replay(): Promise<ReplayResult> {
    if (running !== null) return running;
    const flight = (async (): Promise<ReplayResult> => {
      const total: ReplayResult = { sent: 0, failed: 0, waiting: 0, halted: null, leaseBusy: false };
      let last: RunReport;
      do {
        again = false;
        last = await runOnce();
        total.sent += last.result.sent;
        total.failed += last.result.failed;
        total.waiting = last.result.waiting;
        total.halted = last.result.halted;
        total.leaseBusy = last.result.leaseBusy;
      } while (again && !stopped);
      if (total.halted === 'auth' || total.halted === 'upgrade') {
        const reason = total.halted;
        notify(() => deps.onHalt?.(reason));
      }
      scheduleRetry(last);
      return total;
    })().finally(() => {
      running = null;
    });
    running = flight;
    return flight;
  }

  function trigger(): void {
    if (stopped) return;
    if (running !== null) {
      again = true;
      return;
    }
    replay().catch(report);
  }

  return {
    replay,
    trigger,
    start: () => {
      if (started || stopped) return;
      started = true;
      unsubscribe.push(
        deps.network.onChange((online) => {
          if (online) trigger();
        }),
      );
      if (deps.appState) {
        unsubscribe.push(
          deps.appState.onChange((active) => {
            if (active) trigger();
          }),
        );
      }
      if (deps.onUnlocked) unsubscribe.push(deps.onUnlocked(trigger));
      trigger();
    },
    stop: () => {
      stopped = true;
      for (const off of unsubscribe.splice(0)) off();
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
    },
    idle: async () => {
      while (running !== null) await running.catch(() => undefined);
    },
    retry: async (idempotencyKey) => {
      const changed = await retryRow(deps.db, idempotencyKey);
      if (changed) trigger();
      return changed;
    },
    discard: (idempotencyKey, options) => discardRow(deps.db, idempotencyKey, options),
  };
}
