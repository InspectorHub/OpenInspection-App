import type { MediaUploader } from '@inspectorhub/field-ui';
import { safeClientHeaders } from '../auth/client-headers';
import { isAuthError } from '../auth/errors';
import type { Http, HttpResponse } from '../auth/http';
import { parseServerUrl } from '../auth/server-config';
import type { TokenManager } from '../auth/tokens';
import { realTimers, type TimerPort } from '../collab/timers';
import { systemClock, type Clock } from '../platform/clock';
import type { UploaderPluginLike } from '../platform/uploader';
import { isValidMediaId } from './errors';
import { isValidUploadedKey, MEDIA_CONTENT_TYPES, type MediaRow, type MediaStore } from './store';
import {
  clampRetryAfter,
  failure,
  isRecord,
  MAX_RETRY_AFTER_MS,
  resolveUploadUrl as resolveSignedUploadUrl,
  type AuthedResult,
  type Failure,
  type KindContext,
  type KindStrategy,
  type UploadFailureCode,
} from './upload-kinds';
import { isExpectedVideoKey } from './video';

export type { UploadFailureCode };
export { MAX_RETRY_AFTER_MS };

/**
 * The attempts value that marks a photo as given up on. Only a PERMANENT refusal (the server or the file says this
 * photo can never be sent) writes it, all at once, so the row stays `failed` and visible until `retry()`. A TRANSIENT
 * failure (network, timeout, 408, 429, 5xx, plugin or disk trouble) keeps counting attempts but saturates one below
 * this value, so a weak network can never give a photo up: it is retried indefinitely with a backoff capped at an hour.
 */
export const MAX_UPLOAD_ATTEMPTS = 1_000_000;
/** First wait after a transient failure; doubles with each further failure. */
export const TRANSIENT_BACKOFF_BASE_MS = 15_000;
/** The longest wait between two automatic tries of a photo that keeps failing for transient reasons. */
export const TRANSIENT_BACKOFF_CAP_MS = 3_600_000;
/**
 * The longest a photo upload may take before it is abandoned and counted as failed. Progress does not extend it: a
 * photo is small, so a transfer that long is stuck.
 */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;
/**
 * The longest a clip transfer may stay SILENT (no progress event from the plugin) before it is abandoned. Every
 * `uploading` event restarts it, so a 100 MB clip on a slow uplink that keeps moving is never aborted and restarted
 * from the beginning.
 */
export const VIDEO_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
/** The absolute ceiling of one clip transfer, whatever progress it reports (a photo has its fixed timeout instead). */
export const MAX_TRANSFER_MS = 6 * 3_600_000;
const MAX_EARLY_EVENTS = 64;
const MAX_EVENT_ID_LENGTH = 128;
const UPLOAD_PATH = '/api/public/uploads/photo';
const NOTIFICATION_TITLE = 'Uploading photos';

export type UploadOutcome =
  | { ok: true; key: string; /** True when the row was already uploaded and nothing was sent. */ reused: boolean }
  | {
      ok: false;
      code: UploadFailureCode;
      /** False when sending again cannot help (the server refused this photo). */
      retryable: boolean;
      /** The server's Retry-After, clamped; null when it gave none. */
      retryAfterMs: number | null;
      /** True when no further upload should be started in this run (locked, signed out, client too old). */
      halt: boolean;
    };

export interface UploadRef {
  pendingId: string;
  inspectionId: string;
}

export interface UploadOptions {
  onProgress?: (pendingId: string, percent: number) => void;
}

export interface NativeUploaderDeps {
  store: MediaStore;
  /** The authenticated wrapper: every call is made to the pinned origin and never follows a redirect. */
  http: Http;
  tokens: Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  plugin: UploaderPluginLike;
  /** The stored, canonical server origin. The only host a signed url may point at. */
  origin: string;
  /** Development switch with the same meaning as for the server screen. */
  allowInsecureHttp?: boolean;
  /** True when the offline lock holds or the device is revoked. A check that throws counts as locked. */
  isLocked(): boolean | Promise<boolean>;
  /**
   * `X-Client-Platform` and `X-Client-Version`, sent with the upload request. The signed url carries its own
   * authority, so `Authorization`, `Cookie` and `Proxy-Authorization` are dropped here whatever their case.
   */
  clientHeaders: Record<string, string>;
  timers?: TimerPort;
  /** Time source of the backoff. Share it with the reconciler, which schedules from the same instants. */
  clock?: Clock;
  random?: () => number;
  /** Photo timeout (total) and, when `videoInactivityTimeoutMs` is not given, the clip silence timeout. */
  uploadTimeoutMs?: number;
  /** The silence timeout of a clip transfer. */
  videoInactivityTimeoutMs?: number;
  /** The absolute ceiling of one clip transfer. */
  maxTransferMs?: number;
  /**
   * Called after `retry()` moved a row back to `pending`, so the reconciler can run now (wire it to `reconciler.trigger()`;
   * the reconciler is created after the uploader, so pass a closure). A throw is ignored.
   */
  onRetry?: (pendingId: string) => void;
  /** Receives storage failures. Never receives a token, a url or a path. */
  onError?: (error: unknown) => void;
  /** How rows of another kind than a photo (a video clip) get a destination and finish. Without it such a row is left untouched. */
  video?: KindStrategy;
  /**
   * The data-layer block (`createBlockedGuard`). A row of a blocked inspection is neither minted, started, finished nor
   * recorded as failed: the upload answers `BLOCKED` and the row stays as it is. A guard that rejects counts as blocked.
   * Without it nothing is checked, so the composition root must pass the real guard.
   */
  isBlocked?: (inspectionId: string) => Promise<boolean>;
}

export interface NativeUploader extends MediaUploader {
  /** Like `upload`, with the reason for a failure. Never throws. One upload per photo at a time: a second call joins the first. */
  uploadDetailed(ref: UploadRef, options?: UploadOptions): Promise<UploadOutcome>;
  /** Registers the plugin listener (once). Events the plugin kept from a previous process are acknowledged and dropped. */
  attach(): Promise<void>;
  /** True while an upload of this photo is in flight in this process. */
  isActive(pendingId: string): boolean;
  /** True when this uploader was given the clip strategy, so it can send and finalize clips. */
  handlesVideo(): boolean;
  /**
   * The earliest time (clock ms) this process will start this photo again after a failure, or null when it
   * remembers none. Memory only: after a restart the stored attempt count alone decides.
   */
  retryAt(pendingId: string): number | null;
  /**
   * The manual retry: forgets the backoff, sets the row back to `pending` with no attempts used, and returns
   * whether the transition happened. It is one conditional update on the state that was read, so a row that
   * changed meanwhile (uploaded, started) is left alone and the answer is false. Does nothing for a photo that is
   * already uploaded or in flight. Calls `onRetry` after a successful transition.
   */
  retry(pendingId: string): Promise<boolean>;
  /** Forgets the backoff memory of every photo not in `keep`, so a photo that is gone leaves nothing behind. */
  forgetExcept(keep: ReadonlySet<string>): void;
  /**
   * Stops the uploads of one inspection that are in flight in this process: asks the plugin to drop them, settles each
   * as `BLOCKED` without recording a failure, and resolves when they have ended. An upload that has not reached the
   * plugin yet stops at the next block check, so this is meant to run after the inspection became blocked. Uploads of
   * other inspections are untouched. An upload the plugin kept from an earlier process cannot be listed and is not
   * reached; its transfer ends on its own and finds no row.
   */
  cancelFor(inspectionId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** What the backoff memory keeps of one photo's failures in this process. */
interface RetryState {
  failures: number;
  nextAt: number;
  last: Failure;
}

/**
 * The wait after a transient failure: 15 s doubling to one hour, jittered between half and full, and never shorter
 * than the server's own Retry-After. `attempt` is the number of failures so far (at least 1).
 */
export function transientBackoffMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, attempt - 1), 30);
  const exponential = Math.min(TRANSIENT_BACKOFF_BASE_MS * 2 ** exponent, TRANSIENT_BACKOFF_CAP_MS);
  const jittered = Math.round(exponential * (0.5 + 0.5 * random()));
  return Math.max(jittered, retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : 0);
}

function toOutcome(f: Failure): UploadOutcome {
  return { ok: false, code: f.code, retryable: f.retryable, retryAfterMs: f.retryAfterMs, halt: f.halt };
}

type Terminal = { kind: 'completed' | 'failed'; statusCode: number | null } | { kind: 'timeout' } | { kind: 'cancelled' };

interface ParsedEvent {
  name: 'uploading' | 'completed' | 'failed';
  id: string;
  eventId: string | undefined;
  percent: number | null;
  statusCode: number | null;
}

/** An event is data from another process: only the three names, a bounded id and integer status are accepted. */
function parseEvent(raw: unknown): ParsedEvent | null {
  if (!isRecord(raw)) return null;
  const { name, id, eventId, payload } = raw;
  if (name !== 'uploading' && name !== 'completed' && name !== 'failed') return null;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_EVENT_ID_LENGTH) return null;
  const data = isRecord(payload) ? payload : {};
  const percent = typeof data.percent === 'number' && Number.isFinite(data.percent) ? Math.max(0, Math.min(100, data.percent)) : null;
  const statusCode = typeof data.statusCode === 'number' && Number.isInteger(data.statusCode) ? data.statusCode : null;
  return {
    name,
    id,
    eventId: typeof eventId === 'string' && eventId.length > 0 && eventId.length <= MAX_EVENT_ID_LENGTH ? eventId : undefined,
    percent,
    statusCode,
  };
}

/**
 * The signed upload url, resolved against the pinned origin and accepted only in the one shape the engine
 * mints: same origin, no userinfo, the photo path, a single well-formed `token` parameter, no fragment.
 * A url naming any other host, scheme, port or path is refused, so a photo is never sent to a place the
 * server answer merely pointed at.
 */
export function resolveUploadUrl(origin: string, raw: unknown): string | null {
  return resolveSignedUploadUrl(origin, raw, UPLOAD_PATH);
}

/**
 * True for exactly the key this row's upload leaves: `<tenant>/inspections/<inspection>/photos/<pendingId>.<ext>` for a
 * photo, with this row's ids and extension; a clip's own key shape (see `isExpectedVideoKey`) for a clip.
 */
export function isExpectedKey(key: unknown, row: MediaRow): key is string {
  if (row.kind === 'video') return isExpectedVideoKey(key, row);
  if (!isValidUploadedKey(key)) return false;
  const parts = key.split('/');
  return (
    parts.length === 5 &&
    isValidMediaId(parts[0]) &&
    parts[1] === 'inspections' &&
    parts[2] === row.inspectionId &&
    parts[3] === 'photos' &&
    parts[4] === `${row.pendingId}.${MEDIA_CONTENT_TYPES[row.contentType]}`
  );
}

type StatusClass = { kind: 'success' } | { kind: 'auth' } | { kind: 'failure'; failure: Failure };

/** Maps the HTTP status of the upload to what it means. Only a 2xx is success. */
function classifyStatus(status: number): StatusClass {
  if (status >= 200 && status <= 299) return { kind: 'success' };
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (status === 400 || status === 404 || status === 411 || status === 413 || status === 415 || status === 422) {
    return { kind: 'failure', failure: failure('REJECTED', { retryable: false }) };
  }
  return { kind: 'failure', failure: failure('SERVER', { retryable: true }) };
}

type Minted = { ok: true; url: string; key: string; sendClientHeaders: boolean } | { ok: false; failure: Failure };

export function createNativeUploader(deps: NativeUploaderDeps): NativeUploader {
  const origin = parseServerUrl(deps.origin, { allowInsecureHttp: deps.allowInsecureHttp === true });
  const timers = deps.timers ?? realTimers;
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? Math.random;
  const clientHeaders = safeClientHeaders(deps.clientHeaders);
  const retries = new Map<string, RetryState>();
  const timeoutMs = deps.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  const silenceMs = deps.videoInactivityTimeoutMs ?? (deps.uploadTimeoutMs === undefined ? VIDEO_INACTIVITY_TIMEOUT_MS : timeoutMs);
  const ceilingMs = deps.maxTransferMs ?? MAX_TRANSFER_MS;
  const active = new Map<string, Promise<UploadOutcome>>();
  const waiters = new Map<string, { settle(terminal: Terminal): void; pendingId: string; onProgress: ((pendingId: string, percent: number) => void) | undefined; touch(): void }>();
  const early = new Map<string, ParsedEvent>();
  /** The inspection of every upload in flight in this process, by photo. */
  const inspectionOf = new Map<string, string>();
  /** Inspections a `cancelFor` is working on: an upload that registers meanwhile is cancelled at once. */
  const cancelling = new Map<string, number>();
  let starting = 0;
  let listener: Promise<{ remove(): Promise<void> }> | null = null;

  function report(error: unknown): void {
    try {
      deps.onError?.(error);
    } catch {
      // A failing reporter must not change what the upload does.
    }
  }

  function acknowledge(eventId: string | undefined): void {
    if (eventId === undefined) return;
    deps.plugin.acknowledgeEvent({ eventId }).catch(() => undefined);
  }

  /** Terminal events nobody claimed once no start is pending belong to uploads of an earlier process. */
  function dropUnclaimed(): void {
    if (starting > 0) return;
    for (const event of early.values()) acknowledge(event.eventId);
    early.clear();
  }

  function onEvent(raw: unknown): void {
    const event = parseEvent(raw);
    if (event === null) return;
    const waiter = waiters.get(event.id);
    if (event.name === 'uploading') {
      waiter?.touch();
      if (waiter?.onProgress && event.percent !== null) waiter.onProgress(waiter.pendingId, event.percent);
      return;
    }
    if (waiter) {
      waiters.delete(event.id);
      acknowledge(event.eventId);
      waiter.settle({ kind: event.name, statusCode: event.statusCode });
      return;
    }
    // An upload that finishes before its start call has answered is claimed when the answer arrives.
    if (starting > 0 && early.size < MAX_EARLY_EVENTS) {
      early.set(event.id, event);
      return;
    }
    acknowledge(event.eventId);
  }

  function attach(): Promise<void> {
    if (listener === null) {
      const registered = deps.plugin.addListener('events', onEvent);
      listener = registered;
      registered.catch(() => {
        if (listener === registered) listener = null;
      });
    }
    return listener.then(() => undefined);
  }

  async function locked(): Promise<boolean> {
    try {
      return await deps.isLocked();
    } catch {
      return true;
    }
  }

  /** True when the guard says blocked or cannot say. Without a guard nothing is blocked. */
  async function blocked(inspectionId: string): Promise<boolean> {
    if (deps.isBlocked === undefined) return false;
    try {
      return (await deps.isBlocked(inspectionId)) !== false;
    } catch {
      return true;
    }
  }

  const blockedOutcome = (): UploadOutcome => toOutcome(failure('BLOCKED', { retryable: true }));

  /** An authenticated JSON POST to the pinned origin. A 401 refreshes the session once; everything else is answered, never thrown. */
  async function authedPost(path: string, body: unknown): Promise<AuthedResult> {
    let refreshed = false;
    for (;;) {
      let token: string | null;
      try {
        token = await deps.tokens.getAccessToken(origin);
      } catch {
        return { ok: false, failure: failure('NETWORK', { retryable: true }) };
      }
      if (token === null) return { ok: false, failure: failure('AUTH', { retryable: true, halt: true }) };
      let res: HttpResponse;
      try {
        res = await deps.http.request({
          url: `${origin}${path}`,
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        if (isAuthError(err) && err.code === 'server_redirected') return { ok: false, failure: failure('BAD_URL', { retryable: true }) };
        return { ok: false, failure: failure('NETWORK', { retryable: true }) };
      }
      if (res.status !== 401) return { ok: true, res };
      if (refreshed) return { ok: false, failure: failure('AUTH', { retryable: true }) };
      refreshed = true;
      try {
        const check = await deps.tokens.checkSession(origin);
        if (check.kind === 'relogin' || check.kind === 'signed_out') return { ok: false, failure: failure('AUTH', { retryable: true, halt: true }) };
      } catch {
        return { ok: false, failure: failure('NETWORK', { retryable: true }) };
      }
    }
  }

  const kindContext: KindContext = { origin, post: authedPost };

  async function mint(row: MediaRow): Promise<Minted> {
    const answer = await authedPost(`/api/inspections/${encodeURIComponent(row.inspectionId)}/media/upload-url`, { pendingId: row.pendingId, contentType: row.contentType });
    if (!answer.ok) return answer;
    const { res } = answer;
    if (res.status === 200) return parseMinted(res.json, row);
    if ([400, 403, 404, 411, 413, 415, 422].includes(res.status)) return { ok: false, failure: failure('REJECTED', { retryable: false }) };
    if (res.status === 426) return { ok: false, failure: failure('UPGRADE', { retryable: true, halt: true }) };
    return { ok: false, failure: failure('SERVER', { retryable: true, retryAfterMs: clampRetryAfter(res.retryAfterMs) }) };
  }

  /**
   * An answer that is not a well-formed success (unreadable, a captive portal's page, an error shape) is transient.
   * A well-formed success that names a url or key this photo may not use is the server being wrong, which no
   * amount of waiting repairs: permanent.
   */
  function parseMinted(body: unknown, row: MediaRow): Minted {
    if (!isRecord(body) || body.success !== true || !isRecord(body.data)) return { ok: false, failure: failure('BAD_URL', { retryable: true }) };
    const url = resolveUploadUrl(origin, body.data.url);
    const key = body.data.key;
    if (url === null || !isExpectedKey(key, row)) return { ok: false, failure: failure('BAD_URL', { retryable: false }) };
    return { ok: true, url, key, sendClientHeaders: true };
  }

  /** Hands the file to the plugin and waits for the one terminal event that names it. */
  async function runUpload(row: MediaRow, target: { url: string; sendClientHeaders: boolean; title: string; silenceTimeout: boolean }, options: UploadOptions): Promise<Terminal | 'start-failed'> {
    let filePath: string;
    try {
      filePath = await deps.store.fileUri(row);
    } catch {
      return 'start-failed';
    }
    starting += 1;
    let id: string;
    try {
      const started = await deps.plugin.startUpload({
        filePath,
        serverUrl: target.url,
        method: 'POST',
        uploadType: 'multipart',
        fileField: 'file',
        mimeType: row.contentType,
        maxRetries: 3,
        headers: target.sendClientHeaders ? { ...clientHeaders } : {},
        notificationTitle: target.title,
      });
      if (typeof started.id !== 'string' || started.id.length === 0 || started.id.length > MAX_EVENT_ID_LENGTH) throw new Error('invalid upload id');
      id = started.id;
    } catch {
      starting -= 1;
      dropUnclaimed();
      return 'start-failed';
    }
    let settle: (terminal: Terminal) => void = () => undefined;
    const done = new Promise<Terminal>((resolve) => {
      settle = resolve;
    });
    let timer: unknown = null;
    const arm = (ms: number): unknown => timers.setTimeout(() => settle({ kind: 'timeout' }), ms);
    // A clip's timer restarts on every progress event; a photo's runs once. The ceiling bounds both.
    const touch = (): void => {
      if (!target.silenceTimeout) return;
      timers.clearTimeout(timer);
      timer = arm(silenceMs);
    };
    waiters.set(id, { settle, pendingId: row.pendingId, onProgress: options.onProgress, touch });
    if (cancelling.has(row.inspectionId)) {
      // A cancel was asked for while this start was in flight: it could not see the upload yet.
      waiters.delete(id);
      void deps.plugin.removeUpload({ id }).catch(() => undefined);
      settle({ kind: 'cancelled' });
    }
    const queued = early.get(id);
    if (queued !== undefined && queued.name !== 'uploading') {
      early.delete(id);
      waiters.delete(id);
      acknowledge(queued.eventId);
      settle({ kind: queued.name, statusCode: queued.statusCode });
    }
    starting -= 1;
    dropUnclaimed();
    timer = arm(target.silenceTimeout ? silenceMs : timeoutMs);
    const ceiling = target.silenceTimeout ? arm(ceilingMs) : null;
    const terminal = await done;
    timers.clearTimeout(timer);
    if (ceiling !== null) timers.clearTimeout(ceiling);
    waiters.delete(id);
    if (terminal.kind === 'timeout') await deps.plugin.removeUpload({ id }).catch(() => undefined);
    return terminal;
  }

  /**
   * Records a failure. A halting one (locked, signed out, client too old) says nothing about the photo, so it
   * costs no attempt and a row already marked `uploading` goes back to what it was. Every other failure is a
   * counted attempt and the row becomes `failed`. A permanent refusal uses every attempt at once (given up,
   * visible, waits for `retry()`). A transient one adds one attempt, never reaching the given-up marker, and
   * backs off from 15 s up to an hour with no end: the reconciler wakes at exactly this instant (`retryAt`).
   */
  async function settleFailure(row: MediaRow, f: Failure, marked: boolean): Promise<UploadOutcome> {
    if (f.halt) {
      if (marked) {
        try {
          await deps.store.markState(row.pendingId, row.state, { attempts: row.attempts });
        } catch (error) {
          report(error);
        }
      }
      return toOutcome(f);
    }
    const attempts = f.retryable ? Math.min(row.attempts + 1, MAX_UPLOAD_ATTEMPTS - 1) : MAX_UPLOAD_ATTEMPTS;
    const seen = (retries.get(row.pendingId)?.failures ?? 0) + 1;
    retries.set(row.pendingId, {
      failures: seen,
      // A permanent refusal has nothing left to wait for; a transient failure always waits.
      nextAt: f.retryable ? clock.now() + transientBackoffMs(Math.max(seen, attempts), f.retryAfterMs, random) : 0,
      last: f,
    });
    try {
      await deps.store.markState(row.pendingId, 'failed', { attempts });
    } catch (error) {
      report(error);
    }
    return toOutcome(f);
  }

  /** The stored answer when the policy says this photo must not be started now, or null when it may be. */
  function gate(row: MediaRow): UploadOutcome | null {
    const state = retries.get(row.pendingId);
    if (row.state === 'failed' && row.attempts >= MAX_UPLOAD_ATTEMPTS) {
      return state ? toOutcome({ ...state.last, retryable: false, halt: false }) : toOutcome(failure('GIVEN_UP', { retryable: false }));
    }
    if (state !== undefined && state.nextAt > clock.now()) return toOutcome(state.last);
    return null;
  }

  /**
   * The step a kind's strategy owns once the file has arrived (finalize for a clip). The key that says where the file
   * is was written to the row before this runs, so a kill from here on resumes at this step without a second
   * transfer. Locking after the transfer stops it here: nothing is sent for a device that is no longer allowed to.
   */
  async function completeWith(row: MediaRow, strategy: KindStrategy, key: string, marked: boolean): Promise<UploadOutcome> {
    if (await locked()) return settleFailure(row, failure('LOCKED', { retryable: true, halt: true }), marked);
    if (await blocked(row.inspectionId)) return blockedOutcome();
    if (!marked) {
      try {
        if (!(await deps.store.markState(row.pendingId, 'uploading', { attempts: row.attempts }))) return toOutcome(failure('NOT_FOUND', { retryable: false }));
      } catch (error) {
        report(error);
        return settleFailure(row, failure('STORE', { retryable: true }), false);
      }
    }
    const done = await strategy.complete(row, key, kindContext);
    if (!done.ok) return settleFailure(row, done.failure, true);
    retries.delete(row.pendingId);
    try {
      await deps.store.markState(row.pendingId, 'uploaded', { attempts: row.attempts, uploadedKey: key });
    } catch (error) {
      // The server holds it; the row stays `uploading` with its key, and the next run repeats the (idempotent) step.
      report(error);
    }
    return { ok: true, key, reused: false };
  }

  /** The file on disk is checked against the kind's ceiling before any request: a file that grew or was swapped is never sent. */
  async function checkSize(row: MediaRow, strategy: KindStrategy): Promise<UploadOutcome | null> {
    let size: number | null;
    try {
      size = await deps.store.fileSize(row);
    } catch {
      return settleFailure(row, failure('FILE', { retryable: true }), false);
    }
    if (size === null) return null;
    if (size > strategy.maxBytes) return settleFailure(row, failure('TOO_LARGE', { retryable: false }), false);
    if (size === 0) return settleFailure(row, failure('FILE', { retryable: false }), false);
    return null;
  }

  async function doUpload(ref: UploadRef, options: UploadOptions): Promise<UploadOutcome> {
    if (await locked()) return toOutcome(failure('LOCKED', { retryable: true, halt: true }));
    let row: MediaRow | null;
    try {
      row = await deps.store.getRow(ref.pendingId);
    } catch (error) {
      report(error);
      return toOutcome(failure('STORE', { retryable: true }));
    }
    if (row === null) {
      retries.delete(ref.pendingId);
      return toOutcome(failure('NOT_FOUND', { retryable: false }));
    }
    if (row.inspectionId !== ref.inspectionId) return toOutcome(failure('INVALID', { retryable: false }));
    // First of all, before the row is read any further or anything is sent: a blocked inspection's rows are left alone.
    if (await blocked(row.inspectionId)) return blockedOutcome();
    const strategy = deps.video !== undefined && deps.video.kind === row.kind ? deps.video : undefined;
    if (row.kind !== 'photo' && strategy === undefined) return toOutcome(failure('UNSUPPORTED_KIND', { retryable: false }));
    // A key that is not this row's own (a tampered row) is never reused or handed on: the file is sent again.
    if (row.state === 'uploaded' && isExpectedKey(row.uploadedKey, row)) {
      retries.delete(row.pendingId);
      return { ok: true, key: row.uploadedKey, reused: true };
    }
    const held = gate(row);
    if (held !== null) return held;
    // The file arrived in an earlier run and only the finishing step is owed: no new destination, no second transfer.
    if (strategy !== undefined && strategy.isExpectedKey(row.uploadedKey, row)) return completeWith(row, strategy, row.uploadedKey, false);

    let present: boolean;
    try {
      present = await deps.store.fileExists(row);
    } catch {
      return settleFailure(row, failure('FILE', { retryable: true }), false);
    }
    if (!present) return settleFailure(row, failure('FILE', { retryable: false }), false);
    if (strategy !== undefined) {
      const refusedSize = await checkSize(row, strategy);
      if (refusedSize !== null) return refusedSize;
    }
    try {
      await attach();
    } catch {
      return settleFailure(row, failure('PLUGIN', { retryable: true }), false);
    }

    let marked = false;
    let refusedOnce = false;
    for (;;) {
      const minted = strategy === undefined ? await mint(row) : await strategy.mint(row, kindContext);
      if (!minted.ok) return settleFailure(row, minted.failure, marked);
      // Signing out or locking while the url was being minted must not start the transfer.
      if (await locked()) return settleFailure(row, failure('LOCKED', { retryable: true, halt: true }), marked);
      // Nor may a purge or a quarantine that began meanwhile: the row stays as it is, nothing is recorded.
      if (await blocked(row.inspectionId)) return blockedOutcome();
      if (!marked) {
        // Starting costs no attempt: only a recorded failure does, so a process that keeps being killed cannot fail a good file.
        try {
          if (!(await deps.store.markState(row.pendingId, 'uploading', { attempts: row.attempts }))) return toOutcome(failure('NOT_FOUND', { retryable: false }));
        } catch (error) {
          report(error);
          return settleFailure(row, failure('STORE', { retryable: true }), false);
        }
        marked = true;
      }
      const terminal = await runUpload(row, { url: minted.url, sendClientHeaders: minted.sendClientHeaders, title: strategy?.notificationTitle ?? NOTIFICATION_TITLE, silenceTimeout: strategy !== undefined }, options);
      if (terminal === 'start-failed') return settleFailure(row, failure('FILE', { retryable: true }), marked);
      if (terminal.kind === 'cancelled') return blockedOutcome();
      if (terminal.kind === 'timeout') return settleFailure(row, failure('TIMEOUT', { retryable: true }), marked);
      if (terminal.statusCode === null) {
        const code = terminal.kind === 'failed' ? 'NETWORK' : 'SERVER';
        return settleFailure(row, failure(code, { retryable: true }), marked);
      }
      const verdict = classifyStatus(terminal.statusCode);
      if (verdict.kind === 'success' && terminal.kind === 'completed') {
        if (strategy !== undefined) {
          // Confirmed 2xx for THIS transfer: remember where the file is (the row stays `uploading` until the step after is done).
          try {
            await deps.store.markState(row.pendingId, 'uploading', { attempts: row.attempts, uploadedKey: minted.key });
          } catch (error) {
            // Not fatal for this run; only a kill before the step finishes would repeat the transfer.
            report(error);
          }
          return completeWith(row, strategy, minted.key, true);
        }
        retries.delete(row.pendingId);
        try {
          await deps.store.markState(row.pendingId, 'uploaded', { attempts: row.attempts, uploadedKey: minted.key });
        } catch (error) {
          // The photo is on the server; an unrecorded success only costs one more (overwriting) upload.
          report(error);
        }
        return { ok: true, key: minted.key, reused: false };
      }
      if (verdict.kind === 'auth' && !refusedOnce) {
        // The signed url was refused (expired, or its issuer lost access): mint a fresh one, once.
        refusedOnce = true;
        continue;
      }
      if (verdict.kind === 'auth') return settleFailure(row, failure('AUTH', { retryable: true }), marked);
      if (verdict.kind === 'failure') return settleFailure(row, verdict.failure, marked);
      return settleFailure(row, failure('NETWORK', { retryable: true }), marked);
    }
  }

  function uploadDetailed(ref: UploadRef, options: UploadOptions = {}): Promise<UploadOutcome> {
    if (!isValidMediaId(ref.pendingId) || !isValidMediaId(ref.inspectionId)) return Promise.resolve(toOutcome(failure('INVALID', { retryable: false })));
    const running = active.get(ref.pendingId);
    if (running) return running;
    inspectionOf.set(ref.pendingId, ref.inspectionId);
    const run = doUpload(ref, options)
      .catch((error: unknown): UploadOutcome => {
        report(error);
        return toOutcome(failure('STORE', { retryable: true }));
      })
      .finally(() => {
        active.delete(ref.pendingId);
        inspectionOf.delete(ref.pendingId);
      });
    active.set(ref.pendingId, run);
    return run;
  }

  return {
    uploadDetailed,
    attach,
    handlesVideo: () => deps.video !== undefined,
    isActive: (pendingId) => active.has(pendingId),
    retryAt: (pendingId) => retries.get(pendingId)?.nextAt ?? null,
    retry: async (pendingId) => {
      if (!isValidMediaId(pendingId) || active.has(pendingId)) return false;
      retries.delete(pendingId);
      try {
        const row = await deps.store.getRow(pendingId);
        if (row === null || row.state === 'uploaded') return false;
        // Conditional on the state just read: a row that was uploaded or started meanwhile is not overwritten.
        const moved = await deps.store.markState(pendingId, 'pending', { attempts: 0, ifState: row.state });
        if (moved) {
          try {
            deps.onRetry?.(pendingId);
          } catch {
            // A failing listener must not undo a retry that was recorded.
          }
        }
        return moved;
      } catch (error) {
        report(error);
        return false;
      }
    },
    forgetExcept: (keep) => {
      for (const id of [...retries.keys()]) if (!keep.has(id)) retries.delete(id);
    },
    upload: async (rec) => {
      const outcome = await uploadDetailed({ pendingId: rec.pendingId, inspectionId: rec.inspectionId });
      return outcome.ok ? { ok: true, key: outcome.key } : { ok: false, error: outcome.code };
    },
    cancelFor: async (inspectionId) => {
      cancelling.set(inspectionId, (cancelling.get(inspectionId) ?? 0) + 1);
      try {
        const mine = new Set([...inspectionOf].filter(([, owner]) => owner === inspectionId).map(([pendingId]) => pendingId));
        const removals: Promise<void>[] = [];
        for (const [id, waiter] of [...waiters]) {
          if (!mine.has(waiter.pendingId)) continue;
          waiters.delete(id);
          removals.push(deps.plugin.removeUpload({ id }).catch(() => undefined));
          waiter.settle({ kind: 'cancelled' });
        }
        await Promise.all(removals);
        const flights = [...mine].map((pendingId) => active.get(pendingId)).filter((flight): flight is Promise<UploadOutcome> => flight !== undefined);
        await Promise.allSettled(flights);
      } finally {
        const left = (cancelling.get(inspectionId) ?? 1) - 1;
        if (left <= 0) cancelling.delete(inspectionId);
        else cancelling.set(inspectionId, left);
      }
    },
    dispose: async () => {
      const registered = listener;
      listener = null;
      if (registered === null) return;
      try {
        await (await registered).remove();
      } catch {
        // Already gone.
      }
    },
  };
}
