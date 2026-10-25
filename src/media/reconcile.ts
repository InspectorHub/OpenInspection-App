import { realTimers, type TimerPort } from '../collab/timers';
import type { AppStatePort } from '../offline/lock-monitor';
import type { Clock } from '../platform/clock';
import type { Network } from '../platform/network';
import { isMediaError, MediaError } from './errors';
import { isExpectedKey, MAX_UPLOAD_ATTEMPTS, type NativeUploader, type UploadFailureCode } from './native-uploader';
import type { ResolveResult } from './pending-doc';
import type { MediaKind, MediaRow, MediaStore } from './store';
import { videoRefFromKey, type ResolveVideo } from './video';

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
/** The longest delay the retry timer is ever armed with: far below the timer limit (2^31 - 1 ms), whatever the clock did. */
export const MAX_RETRY_DELAY_MS = 86_400_000;
/** How long a run that was cut short, or left rows outstanding, waits before it looks again when nothing else wakes it. */
export const DEFAULT_FALLBACK_INTERVAL_MS = 300_000;
/** First wait before the document step of an uploaded photo is tried again after it failed; doubles up to the cap. */
export const DOC_RETRY_BASE_MS = 5000;
export const DOC_RETRY_CAP_MS = 300_000;
/** First wait before the document of an uploaded photo is looked at again after it had no such entry; doubles up to the cap. */
export const MISSING_RECHECK_BASE_MS = 60_000;
export const MISSING_RECHECK_CAP_MS = 3_600_000;

export interface ReconcileDeps {
  store: MediaStore;
  uploader: Pick<NativeUploader, 'uploadDetailed' | 'attach' | 'isActive' | 'retryAt' | 'forgetExcept' | 'handlesVideo'>;
  resolvePending: ResolvePending;
  /**
   * The document step of a clip. Required whenever clips are handled: without a placement step a finalized clip would
   * be deleted from the device with nothing resolving its placeholder, so construction throws. A throw keeps the
   * file and the row and is retried with a growing wait. `missing` is treated exactly as for a photo: the file and the
   * row stay and the entry is asked for again with the same growing wait, because a fast upload can finish before the
   * placeholder entry is written and deleting then would leave a placeholder nothing resolves.
   */
  resolveVideo?: ResolveVideo;
  /**
   * The kinds of rows this reconciler works on. The default follows the uploader: photos, plus clips when the uploader
   * was given the clip strategy. An explicit list must agree with the uploader (a clip kind it cannot send would be
   * left untouched every run; a clip kind it sends but this list omits would never be picked up), or construction throws.
   */
  kinds?: readonly MediaKind[];
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
  /**
   * The data-layer block (`createBlockedGuard`). Rows of a blocked inspection are skipped: not started, not finished,
   * not failed, not counted and not waited for (they wake again through `trigger()` when the block is lifted). Asked once per
   * inspection per run; a guard that rejects counts as blocked. REQUIRED, with no default: a composition root that
   * forgets it does not compile.
   */
  isBlocked: (inspectionId: string) => Promise<boolean>;
  timers?: TimerPort;
  /**
   * The slow fallback timer, armed only while the reconciler is started and the last run was cut short (signed
   * out, client too old, locked, offline, a scan that failed) or ended with rows outstanding that no other wake
   * covers. It exists because those halts have no signal of their own once the device stays online and in the
   * foreground. Default 5 minutes; never below one second, never above a day; jittered to 75% to 125%.
   */
  fallbackIntervalMs?: number;
  /** Source of the jitter; tests only. */
  random?: () => number;
  concurrency?: number;
  maxRowsPerPass?: number;
  /** Progress of the upload of one photo, 0 to 100. */
  onProgress?: (pendingId: string, percent: number) => void;
  /** Receives failures of the document step and of storage. Never receives a token, a url or a path. */
  onError?: (error: unknown) => void;
  /** Receives the fixed code of every upload that stopped the run (`AUTH`, `UPGRADE`, `LOCKED`, ...), so the interface can say why uploads stand still. */
  onHalt?: (code: UploadFailureCode) => void;
}

export interface MediaReconciler {
  /**
   * One run over the table: starts what is pending, restarts what a restart left in `uploading`, retries
   * what failed once its backoff has passed, and finishes (document, then delete) what is uploaded.
   * Concurrent calls share one run. Does nothing while locked, revoked, signed out, offline or stopped.
   */
  reconcileUploads(): Promise<ReconcileResult>;
  /**
   * `reconcileUploads()` for an event: a trigger that arrives during a run makes one more run after it. This is
   * also the call to make right after a sign-in (or a client update): a run halted for AUTH or UPGRADE resumes
   * at once instead of waiting for the slow fallback timer.
   */
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
  /** True when the scan did not reach the end of the table (attach or a page failed, or the page limit was used up). */
  incomplete: boolean;
  /** True when at least one row is neither done nor permanently failed, whether or not it has a wake of its own. */
  outstanding: boolean;
  /** The earliest future instant at which something waits for its turn, or null. */
  wake: number | null;
  /** Every id the scan listed, when it listed the whole table. */
  seen: Set<string> | null;
  /** The guard's answer per inspection, for this run only. */
  blockedAnswers: Map<string, Promise<boolean>>;
}

export function createMediaReconciler(deps: ReconcileDeps): MediaReconciler {
  const timers = deps.timers ?? realTimers;
  const uploaderHasVideo = deps.uploader.handlesVideo();
  const kinds: readonly MediaKind[] = deps.kinds !== undefined && deps.kinds.length > 0 ? deps.kinds : uploaderHasVideo ? ['photo', 'video'] : ['photo'];
  const handlesVideo = kinds.includes('video');
  if (handlesVideo && !uploaderHasVideo) throw new Error('createMediaReconciler: kinds names video but the uploader has no video strategy');
  if (!handlesVideo && uploaderHasVideo) throw new Error('createMediaReconciler: the uploader has a video strategy but kinds omits video');
  if (handlesVideo && deps.resolveVideo === undefined) throw new Error('createMediaReconciler: video is enabled but resolveVideo is missing');
  const concurrency = Math.max(1, Math.min(Math.floor(deps.concurrency ?? DEFAULT_CONCURRENCY), MAX_CONCURRENCY));
  const maxRows = Math.max(1, Math.floor(deps.maxRowsPerPass ?? DEFAULT_MAX_ROWS_PER_PASS));
  /** Uploaded photos whose pending entry was not in the document: when to look again, and how often it was not. */
  const missing = new Map<string, { misses: number; nextAt: number }>();
  /** Uploaded photos whose document step (or local delete) failed: how often, in this process only. */
  const docFailures = new Map<string, number>();
  const fallbackInterval = Math.max(MIN_RETRY_DELAY_MS, Math.min(deps.fallbackIntervalMs ?? DEFAULT_FALLBACK_INTERVAL_MS, MAX_RETRY_DELAY_MS));
  const random = deps.random ?? Math.random;
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

  function reportHalt(code: UploadFailureCode): void {
    try {
      deps.onHalt?.(code);
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

  /** True when the inspection of a row is blocked (or the guard cannot say). Asked once per inspection per run. */
  function isBlockedFor(inspectionId: string, run: RunReport): Promise<boolean> {
    const known = run.blockedAnswers.get(inspectionId);
    if (known !== undefined) return known;
    const asked = (async (): Promise<boolean> => {
      try {
        return (await deps.isBlocked(inspectionId)) !== false;
      } catch {
        return true;
      }
    })();
    run.blockedAnswers.set(inspectionId, asked);
    return asked;
  }

  /** A failed document step or local delete: the row stays `uploaded` with its file, and wakes itself with a growing wait. */
  function noteDocFailure(row: MediaRow, run: RunReport, error: unknown): void {
    report(error);
    const failures = (docFailures.get(row.pendingId) ?? 0) + 1;
    docFailures.set(row.pendingId, failures);
    noteWake(run, deps.clock.now() + Math.min(DOC_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 20), DOC_RETRY_CAP_MS));
  }

  /** The document step of the row's kind. */
  function resolveDocument(row: MediaRow, key: string): Promise<ResolveResult> {
    if (row.kind !== 'video') return deps.resolvePending(row.inspectionId, row.pendingId, key);
    const ref = videoRefFromKey(key, row.inspectionId);
    if (ref === null) return Promise.reject(new MediaError('INVALID_RECORD'));
    return deps.resolveVideo ? deps.resolveVideo(row.inspectionId, row.pendingId, ref) : Promise.reject(new MediaError('INVALID_RECORD'));
  }

  /**
   * Document first, then the local copy: the file is never removed before the document holds the server key
   * (for a clip: before the server holds the finalized clip and the document step, when wired, has run).
   * Returns true when the file is fully done (document updated, row and file removed).
   */
  async function finish(row: MediaRow, key: string, run: RunReport): Promise<boolean> {
    let resolved: ResolveResult;
    try {
      resolved = await resolveDocument(row, key);
    } catch (error) {
      // The inspection became blocked while this row was in flight: nothing happened, nothing is counted against it.
      if (isMediaError(error) && error.code === 'BLOCKED') return false;
      noteDocFailure(row, run, error);
      return false;
    }
    if (resolved === 'missing') {
      // Nothing is deleted, for a photo or a clip: the entry may not have been written yet (a fast upload can finish before
      // the placeholder is), or the media was removed in the editor.
      docFailures.delete(row.pendingId);
      const misses = (missing.get(row.pendingId)?.misses ?? 0) + 1;
      const wait = Math.min(MISSING_RECHECK_BASE_MS * 2 ** (misses - 1), MISSING_RECHECK_CAP_MS);
      const nextAt = deps.clock.now() + wait;
      missing.set(row.pendingId, { misses, nextAt });
      noteWake(run, nextAt);
      return false;
    }
    try {
      await deps.store.delete(row.pendingId);
    } catch (error) {
      noteDocFailure(row, run, error);
      return false;
    }
    missing.delete(row.pendingId);
    docFailures.delete(row.pendingId);
    run.total.confirmed += 1;
    return true;
  }

  /** Returns true when the whole run should stop (locked, signed out, client too old). */
  async function processRow(row: MediaRow, run: RunReport): Promise<boolean> {
    try {
      if (!(await allowed())) {
        run.blocked = true;
        return true;
      }
      // A blocked inspection's rows are left exactly as they are: no upload, no document step, no failure, no wait.
      if (await isBlockedFor(row.inspectionId, run)) return false;
      // A stored key that is not this photo's own is never resolved into a document: the uploader sends the photo again.
      if (row.state === 'uploaded' && isExpectedKey(row.uploadedKey, row)) {
        const wait = missing.get(row.pendingId);
        if (wait !== undefined && wait.nextAt > deps.clock.now()) {
          run.outstanding = true;
          noteWake(run, wait.nextAt);
          return false;
        }
        if (!(await finish(row, row.uploadedKey, run))) run.outstanding = true;
        return false;
      }
      if (row.state === 'failed' && row.attempts >= MAX_UPLOAD_ATTEMPTS) return false;
      const waitUntil = deps.uploader.retryAt(row.pendingId);
      if (waitUntil !== null && waitUntil > deps.clock.now()) {
        run.outstanding = true;
        noteWake(run, waitUntil);
        return false;
      }
      if (row.state === 'uploading') {
        if (deps.uploader.isActive(row.pendingId)) {
          run.outstanding = true;
          return false;
        }
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
        if (!(await finish(row, outcome.key, run))) run.outstanding = true;
        return false;
      }
      if (!outcome.ok && outcome.code === 'BLOCKED') return false;
      if (outcome.halt) {
        reportHalt(outcome.code);
        run.blocked = true;
        return true;
      }
      if (row.state !== 'pending') run.total.retried += 1;
      if (outcome.retryable) {
        // The uploader's own next instant is the single source of the wake.
        run.outstanding = true;
        const next = deps.uploader.retryAt(row.pendingId);
        if (next !== null) noteWake(run, next);
      }
      return false;
    } catch (error) {
      report(error);
      run.outstanding = true;
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
    for (const id of [...docFailures.keys()]) if (!seen.has(id)) docFailures.delete(id);
  }

  async function runOnce(): Promise<RunReport> {
    const run: RunReport = { total: { retried: 0, confirmed: 0 }, blocked: false, incomplete: false, outstanding: false, wake: null, seen: null, blockedAnswers: new Map() };
    if (!(await allowed())) {
      run.blocked = true;
      return run;
    }
    try {
      await deps.uploader.attach();
    } catch (error) {
      report(error);
      run.incomplete = true;
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
          kinds,
          skipGivenUpAt: MAX_UPLOAD_ATTEMPTS,
          limit: maxRows,
          ...(after ? { after } : {}),
        });
      } catch (error) {
        report(error);
        run.incomplete = true;
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
    if (!complete && !run.blocked) run.incomplete = true;
    if (complete && !run.blocked && !stopped) {
      run.seen = seen;
      prune(seen);
    }
    return run;
  }

  /** The slow fallback wait: the interval, jittered to 75% to 125%, within the one second floor and the one day ceiling. */
  function fallbackDelay(): number {
    return Math.round(fallbackInterval * (0.75 + 0.5 * random()));
  }

  /**
   * Arms the ONE timer of the reconciler, for the earliest instant something should be looked at again.
   *  - Rows waiting for their turn (backoff, document recheck) give a wake time; it is used when the run was
   *    allowed to proceed, because a timer that fires into a closed gate would only fire again.
   *  - A run that was cut short (locked, offline, signed out, client too old), a scan that failed or stopped at the
   *    page limit, and a run that left rows outstanding with no wake of their own all use the slow fallback
   *    interval instead, and only while the reconciler is started: nothing else wakes a halt that has no signal.
   * Either way the delay is clamped to [1 s, 1 day], so the timer can neither busy-loop nor overflow.
   */
  function scheduleRetry(run: RunReport): void {
    if (retryTimer !== null) {
      timers.clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (stopped) return;
    const candidates: number[] = [];
    if (!run.blocked && run.wake !== null) candidates.push(run.wake - deps.clock.now());
    if (started && (run.blocked || run.incomplete || (run.wake === null && run.outstanding))) candidates.push(fallbackDelay());
    if (candidates.length === 0) return;
    const delay = Math.max(MIN_RETRY_DELAY_MS, Math.min(Math.min(...candidates), MAX_RETRY_DELAY_MS));
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      trigger();
    }, delay);
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
