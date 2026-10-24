import { backoffMs } from '../auth/tokens';
import { realTimers, type TimerPort } from '../collab/timers';
import type { AppStatePort } from '../offline/lock-monitor';
import type { Clock } from '../platform/clock';
import type { Network } from '../platform/network';
import { MAX_UPLOAD_ATTEMPTS, type NativeUploader } from './native-uploader';
import type { ResolveResult } from './pending-doc';
import type { MediaRow, MediaStore } from './store';

export type { ResolveResult };

/** Replaces the pending entry of an uploaded photo in the inspection's document. See `createPendingResolver`. */
export type ResolvePending = (inspectionId: string, pendingId: string, uploadedKey: string) => Promise<ResolveResult>;

export interface ReconcileResult {
  /** Uploads started again for a row that had already been tried: left in `uploading` by a restart, or `failed`. */
  retried: number;
  /** Photos fully done: on the server, in the document, and removed from the device. */
  confirmed: number;
}

export const DEFAULT_CONCURRENCY = 3;
export const DEFAULT_MAX_ROWS_PER_PASS = 500;
/** Pages one reconcile reads at most; a table larger than this many pages is finished by the next trigger. */
const MAX_PAGES = 50;
const MAX_CONCURRENCY = 8;

export interface ReconcileDeps {
  store: MediaStore;
  uploader: Pick<NativeUploader, 'uploadDetailed' | 'attach' | 'isActive'>;
  resolvePending: ResolvePending;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  network: Pick<Network, 'online' | 'onChange'>;
  /** Foreground/background transitions; omitted where there is no such signal. */
  appState?: AppStatePort;
  clock: Clock;
  timers?: TimerPort;
  random?: () => number;
  concurrency?: number;
  maxRowsPerPass?: number;
  /** Progress of the upload of one photo, 0 to 100. */
  onProgress?: (pendingId: string, percent: number) => void;
  /** Receives failures of the document step and of storage. Never receives a token, a url or a path. */
  onError?: (error: unknown) => void;
}

export interface MediaReconciler {
  /**
   * One run over the table: starts what is pending, restarts what a restart left in `uploading`, retries
   * what failed once its backoff has passed, and finishes (document, then delete) what is uploaded.
   * Concurrent calls share one run. Does nothing while locked, revoked, signed out, offline or stopped.
   */
  reconcileUploads(): Promise<ReconcileResult>;
  /** `reconcileUploads()` for an event: a trigger that arrives during a run makes one more run after it. */
  trigger(): void;
  /** Runs now, then on the network coming back, on returning to the foreground, and when a retry is due. */
  start(): void;
  /** Ends the run in progress (no further upload starts), unsubscribes and cancels the retry timer. */
  stop(): void;
  /** Settles when no run is in progress or queued. */
  idle(): Promise<void>;
}

const LIVE_STATES = ['pending', 'uploading', 'failed', 'uploaded'] as const;

export function createMediaReconciler(deps: ReconcileDeps): MediaReconciler {
  const timers = deps.timers ?? realTimers;
  const random = deps.random ?? Math.random;
  const concurrency = Math.max(1, Math.min(Math.floor(deps.concurrency ?? DEFAULT_CONCURRENCY), MAX_CONCURRENCY));
  const maxRows = Math.max(1, Math.floor(deps.maxRowsPerPass ?? DEFAULT_MAX_ROWS_PER_PASS));
  /** Earliest time each failed photo may start again. Memory only: after a restart the attempt count alone decides. */
  const nextAt = new Map<string, number>();
  /** Failures seen in this process, so a failure that burns no stored attempt still backs off. */
  const failures = new Map<string, number>();
  let stopped = false;
  let started = false;
  let running: Promise<ReconcileResult> | null = null;
  let again = false;
  let retryTimer: unknown = null;
  const unsubscribe: (() => void)[] = [];

  function report(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // A failing reporter must not change what the run does.
    }
  }

  async function allowed(): Promise<boolean> {
    if (stopped) return false;
    try {
      if (await deps.isLocked()) return false;
    } catch {
      return false;
    }
    if (stopped) return false;
    try {
      return await deps.network.online();
    } catch {
      return false;
    }
  }

  /** Document first, then the local copy: the file is never removed before the document holds the server key. */
  async function finish(row: MediaRow, key: string, total: ReconcileResult): Promise<void> {
    let resolved: ResolveResult;
    try {
      resolved = await deps.resolvePending(row.inspectionId, row.pendingId, key);
    } catch (error) {
      report(error);
      return;
    }
    if (resolved === 'missing') return;
    try {
      await deps.store.delete(row.pendingId);
    } catch (error) {
      report(error);
      return;
    }
    nextAt.delete(row.pendingId);
    failures.delete(row.pendingId);
    total.confirmed += 1;
  }

  /** Returns true when the whole run should stop (locked, signed out, client too old). */
  async function processRow(row: MediaRow, total: ReconcileResult): Promise<boolean> {
    try {
      if (!(await allowed())) return true;
      if (row.state === 'uploaded' && row.uploadedKey !== null) {
        await finish(row, row.uploadedKey, total);
        return false;
      }
      if (row.state === 'failed' && (row.attempts >= MAX_UPLOAD_ATTEMPTS || (nextAt.get(row.pendingId) ?? 0) > deps.clock.now())) return false;
      if (row.state === 'uploading') {
        if (deps.uploader.isActive(row.pendingId)) return false;
        if (row.attempts >= MAX_UPLOAD_ATTEMPTS) {
          // A restart left it here with every attempt used: give up visibly instead of restarting forever.
          await deps.store.markState(row.pendingId, 'failed', { attempts: row.attempts });
          return false;
        }
      }
      const outcome = await deps.uploader.uploadDetailed(
        { pendingId: row.pendingId, inspectionId: row.inspectionId },
        deps.onProgress ? { onProgress: deps.onProgress } : {},
      );
      if (outcome.ok) {
        if (row.state !== 'pending' && !outcome.reused) total.retried += 1;
        await finish(row, outcome.key, total);
        return false;
      }
      if (outcome.halt) return true;
      if (row.state !== 'pending') total.retried += 1;
      if (outcome.retryable) {
        const seen = (failures.get(row.pendingId) ?? 0) + 1;
        failures.set(row.pendingId, seen);
        const attempt = Math.max(seen, row.attempts + 1);
        if (attempt < MAX_UPLOAD_ATTEMPTS) nextAt.set(row.pendingId, deps.clock.now() + backoffMs(attempt, outcome.retryAfterMs, random));
        else nextAt.delete(row.pendingId);
      } else {
        nextAt.delete(row.pendingId);
      }
      return false;
    } catch (error) {
      report(error);
      return false;
    }
  }

  async function processPage(rows: MediaRow[], total: ReconcileResult): Promise<boolean> {
    let index = 0;
    let halted = false;
    const worker = async (): Promise<void> => {
      while (!halted && !stopped) {
        const row = rows[index];
        index += 1;
        if (row === undefined) return;
        if (await processRow(row, total)) halted = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
    return halted;
  }

  async function runOnce(): Promise<ReconcileResult> {
    const total: ReconcileResult = { retried: 0, confirmed: 0 };
    if (!(await allowed())) return total;
    try {
      await deps.uploader.attach();
    } catch (error) {
      report(error);
      return total;
    }
    let after: { createdAt: number; pendingId: string } | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let rows: MediaRow[];
      try {
        rows = await deps.store.listRows({
          states: LIVE_STATES,
          kinds: ['photo'],
          skipGivenUpAt: MAX_UPLOAD_ATTEMPTS,
          limit: maxRows,
          ...(after ? { after } : {}),
        });
      } catch (error) {
        report(error);
        break;
      }
      const last = rows[rows.length - 1];
      if (last === undefined) break;
      const halted = await processPage(rows, total);
      if (halted || rows.length < maxRows) break;
      after = { createdAt: last.createdAt, pendingId: last.pendingId };
    }
    return total;
  }

  function scheduleRetry(): void {
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (stopped || nextAt.size === 0) return;
    const earliest = Math.min(...nextAt.values());
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      trigger();
    }, Math.max(0, earliest - deps.clock.now()));
  }

  function reconcileUploads(): Promise<ReconcileResult> {
    if (running !== null) return running;
    const run = (async (): Promise<ReconcileResult> => {
      const total: ReconcileResult = { retried: 0, confirmed: 0 };
      do {
        again = false;
        const result = await runOnce();
        total.retried += result.retried;
        total.confirmed += result.confirmed;
      } while (again && !stopped);
      scheduleRetry();
      return total;
    })().finally(() => {
      running = null;
    });
    running = run;
    return run;
  }

  function trigger(): void {
    if (stopped) return;
    if (running !== null) {
      again = true;
      return;
    }
    reconcileUploads().catch(report);
  }

  return {
    reconcileUploads,
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
      trigger();
    },
    stop: () => {
      stopped = true;
      for (const off of unsubscribe.splice(0)) off();
      if (retryTimer !== null) {
        timers.clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
    idle: async () => {
      while (running !== null) await running.catch(() => undefined);
    },
  };
}
