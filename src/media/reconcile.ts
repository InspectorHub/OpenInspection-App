import { realTimers, type TimerPort } from '../collab/timers';
import type { AppStatePort } from '../offline/lock-monitor';
import type { Clock } from '../platform/clock';
import type { Network } from '../platform/network';
import { isExpectedKey, MAX_UPLOAD_ATTEMPTS, type NativeUploader } from './native-uploader';
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
/** The shortest delay the retry timer is ever armed with, so a timer can never turn into a busy loop. */
export const MIN_RETRY_DELAY_MS = 1000;
/** First wait before the document of an uploaded photo is looked at again after it had no such entry; doubles up to the cap. */
export const MISSING_RECHECK_BASE_MS = 60_000;
export const MISSING_RECHECK_CAP_MS = 3_600_000;

export interface ReconcileDeps {
  store: MediaStore;
  uploader: Pick<NativeUploader, 'uploadDetailed' | 'attach' | 'isActive' | 'retryAt' | 'forgetExcept'>;
  resolvePending: ResolvePending;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  /**
   * Calls the listener whenever the device becomes unlocked; returns the unsubscribe function. Without it a run
   * that stopped because of the lock resumes with the next network, foreground or store trigger instead.
   */
  onUnlocked?: (listener: () => void) => () => void;
  network: Pick<Network, 'online' | 'onChange'>;
  /** Foreground/background transitions; omitted where there is no such signal. */
  appState?: AppStatePort;
  /** Must be the clock the uploader was given: both read the same backoff instants. */
  clock: Clock;
  timers?: TimerPort;
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
  /** Runs now, then on the network coming back, on returning to the foreground, on unlock, and when a retry is due. */
  start(): void;
  /** Ends the run in progress (no further upload starts), unsubscribes and cancels the retry timer. */
  stop(): void;
  /** Settles when no run is in progress or queued. */
  idle(): Promise<void>;
  /**
   * Photos that are on the server but whose pending entry was not found in the inspection's document the last
   * time it was looked at (memory only, this process). Their file and row are kept, never deleted: the photo may
   * have been removed in the editor before it synced. Whoever removes a photo from a document must delete its
   * store row too; this count is what a settings screen shows for the rest.
   */
  countUnreferenced(): number;
  /** Forgets the wait before those documents are looked at again and runs now (a new photo was stored, or the user asked). */
  recheckMissing(): void;
}

const LIVE_STATES = ['pending', 'uploading', 'failed', 'uploaded'] as const;

/** What one run found out besides its counts: whether it was cut short, and when the next thing becomes due. */
interface RunReport {
  total: ReconcileResult;
  /** True when the run stopped or skipped work because it was not allowed to proceed (locked, offline, signed out, stopped). */
  blocked: boolean;
  /** The earliest future instant at which something waits for its turn, or null. */
  wake: number | null;
  /** Every id the scan listed, when it listed the whole table. */
  seen: Set<string> | null;
}

export function createMediaReconciler(deps: ReconcileDeps): MediaReconciler {
  const timers = deps.timers ?? realTimers;
  const concurrency = Math.max(1, Math.min(Math.floor(deps.concurrency ?? DEFAULT_CONCURRENCY), MAX_CONCURRENCY));
  const maxRows = Math.max(1, Math.floor(deps.maxRowsPerPass ?? DEFAULT_MAX_ROWS_PER_PASS));
  /** Uploaded photos whose pending entry was not in the document: when to look again, and how often it was not. */
  const missing = new Map<string, { misses: number; nextAt: number }>();
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

  function noteWake(run: RunReport, at: number): void {
    if (at <= deps.clock.now()) return;
    if (run.wake === null || at < run.wake) run.wake = at;
  }

  /** Document first, then the local copy: the file is never removed before the document holds the server key. */
  async function finish(row: MediaRow, key: string, run: RunReport): Promise<void> {
    let resolved: ResolveResult;
    try {
      resolved = await deps.resolvePending(row.inspectionId, row.pendingId, key);
    } catch (error) {
      report(error);
      return;
    }
    if (resolved === 'missing') {
      // Nothing is deleted: the entry may not have been written yet, or the photo was removed in the editor.
      const misses = (missing.get(row.pendingId)?.misses ?? 0) + 1;
      const wait = Math.min(MISSING_RECHECK_BASE_MS * 2 ** (misses - 1), MISSING_RECHECK_CAP_MS);
      const nextAt = deps.clock.now() + wait;
      missing.set(row.pendingId, { misses, nextAt });
      noteWake(run, nextAt);
      return;
    }
    try {
      await deps.store.delete(row.pendingId);
    } catch (error) {
      report(error);
      return;
    }
    missing.delete(row.pendingId);
    run.total.confirmed += 1;
  }

  /** Returns true when the whole run should stop (locked, signed out, client too old). */
  async function processRow(row: MediaRow, run: RunReport): Promise<boolean> {
    try {
      if (!(await allowed())) {
        run.blocked = true;
        return true;
      }
      // A stored key that is not this photo's own is never resolved into a document: the uploader sends the photo again.
      if (row.state === 'uploaded' && isExpectedKey(row.uploadedKey, row)) {
        const wait = missing.get(row.pendingId);
        if (wait !== undefined && wait.nextAt > deps.clock.now()) {
          noteWake(run, wait.nextAt);
          return false;
        }
        await finish(row, row.uploadedKey, run);
        return false;
      }
      if (row.state === 'failed' && row.attempts >= MAX_UPLOAD_ATTEMPTS) return false;
      const waitUntil = deps.uploader.retryAt(row.pendingId);
      if (waitUntil !== null && waitUntil > deps.clock.now()) {
        noteWake(run, waitUntil);
        return false;
      }
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
        if (row.state !== 'pending' && !outcome.reused) run.total.retried += 1;
        await finish(row, outcome.key, run);
        return false;
      }
      if (outcome.halt) {
        run.blocked = true;
        return true;
      }
      if (row.state !== 'pending') run.total.retried += 1;
      const next = deps.uploader.retryAt(row.pendingId);
      if (outcome.retryable && next !== null) noteWake(run, next);
      return false;
    } catch (error) {
      report(error);
      return false;
    }
  }

  async function processPage(rows: MediaRow[], run: RunReport): Promise<boolean> {
    let index = 0;
    let halted = false;
    const worker = async (): Promise<void> => {
      while (!halted && !stopped) {
        const row = rows[index];
        index += 1;
        if (row === undefined) return;
        if (await processRow(row, run)) halted = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, () => worker()));
    return halted;
  }

  /** Forgets what is remembered about photos that are no longer in the table, so a gone photo leaves nothing behind. */
  function prune(seen: ReadonlySet<string>): void {
    deps.uploader.forgetExcept(seen);
    for (const id of [...missing.keys()]) if (!seen.has(id)) missing.delete(id);
  }

  async function runOnce(): Promise<RunReport> {
    const run: RunReport = { total: { retried: 0, confirmed: 0 }, blocked: false, wake: null, seen: null };
    if (!(await allowed())) {
      run.blocked = true;
      return run;
    }
    try {
      await deps.uploader.attach();
    } catch (error) {
      report(error);
      return run;
    }
    const seen = new Set<string>();
    let complete = false;
    let after: { createdAt: number; pendingId: string } | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      let listed: Awaited<ReturnType<MediaStore['listRowsPage']>>;
      try {
        listed = await deps.store.listRowsPage({
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
      // Paging goes by the rows the query returned: a corrupt row must not end it and starve the rows behind it.
      for (const row of listed.rows) seen.add(row.pendingId);
      const halted = listed.rows.length > 0 && (await processPage(listed.rows, run));
      if (halted) break;
      if (listed.rawCount < maxRows) {
        complete = true;
        break;
      }
      if (listed.next === null) break;
      after = listed.next;
    }
    if (complete && !run.blocked && !stopped) {
      run.seen = seen;
      prune(seen);
    }
    return run;
  }

  /**
   * Arms the one retry timer for the earliest future instant something waits for. Nothing is armed when the run
   * was cut short (locked, offline, signed out): the network, foreground, unlock and store triggers resume it,
   * and a timer that fires into a closed gate would only fire again.
   */
  function scheduleRetry(run: RunReport): void {
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (stopped || run.blocked || run.wake === null) return;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      trigger();
    }, Math.max(MIN_RETRY_DELAY_MS, run.wake - deps.clock.now()));
  }

  function reconcileUploads(): Promise<ReconcileResult> {
    if (running !== null) return running;
    const run = (async (): Promise<ReconcileResult> => {
      const total: ReconcileResult = { retried: 0, confirmed: 0 };
      let last: RunReport;
      do {
        again = false;
        last = await runOnce();
        total.retried += last.total.retried;
        total.confirmed += last.total.confirmed;
      } while (again && !stopped);
      scheduleRetry(last);
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
      if (deps.onUnlocked) unsubscribe.push(deps.onUnlocked(trigger));
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
    countUnreferenced: () => missing.size,
    recheckMissing: () => {
      missing.clear();
      trigger();
    },
  };
}
