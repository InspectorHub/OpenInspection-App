import type { MediaUploader } from '@inspectorhub/field-ui';
import { isAuthError } from '../auth/errors';
import type { Http, HttpResponse } from '../auth/http';
import { parseServerUrl } from '../auth/server-config';
import type { TokenManager } from '../auth/tokens';
import { realTimers, type TimerPort } from '../collab/timers';
import type { UploaderPluginLike } from '../platform/uploader';
import { isValidMediaId } from './errors';
import { isValidUploadedKey, MEDIA_CONTENT_TYPES, type MediaRow, type MediaStore } from './store';

/** Starts an upload gives up after this many; a permanent refusal uses them all at once so the row stays failed and visible. */
export const MAX_UPLOAD_ATTEMPTS = 8;
/** The longest one upload may stay silent before it is abandoned and counted as failed. */
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;
/** The longest a server's Retry-After may hold a retry. */
export const MAX_RETRY_AFTER_MS = 300_000;

const MAX_EARLY_EVENTS = 64;
const MAX_EVENT_ID_LENGTH = 128;
const MAX_URL_LENGTH = 4096;
const UPLOAD_PATH = '/api/public/uploads/photo';
const UPLOAD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,512}$/;
const UNSAFE_URL_CHARACTERS = /[\u0000- \u007f\\]/;
const NOTIFICATION_TITLE = 'Uploading photos';

/** The fixed vocabulary of upload failures. Nothing from a server, the plugin or a path is ever added to it. */
export type UploadFailureCode =
  | 'LOCKED'
  | 'AUTH'
  | 'REJECTED'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'FILE'
  | 'BAD_URL'
  | 'INVALID'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_KIND'
  | 'UPGRADE'
  | 'PLUGIN'
  | 'STORE';

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
  /** `X-Client-Platform` and `X-Client-Version`, sent with the upload request. */
  clientHeaders: Record<string, string>;
  timers?: TimerPort;
  uploadTimeoutMs?: number;
  /** Receives storage failures. Never receives a token, a url or a path. */
  onError?: (error: unknown) => void;
}

export interface NativeUploader extends MediaUploader {
  /** Like `upload`, with the reason for a failure. Never throws. One upload per photo at a time: a second call joins the first. */
  uploadDetailed(ref: UploadRef, options?: UploadOptions): Promise<UploadOutcome>;
  /** Registers the plugin listener (once). Events the plugin kept from a previous process are acknowledged and dropped. */
  attach(): Promise<void>;
  /** True while an upload of this photo is in flight in this process. */
  isActive(pendingId: string): boolean;
  dispose(): Promise<void>;
}

interface Failure {
  code: UploadFailureCode;
  retryable: boolean;
  retryAfterMs: number | null;
  halt: boolean;
  /** Write the row as failed (one attempt used, or all of them for a permanent refusal). */
  record: boolean;
}

function failure(code: UploadFailureCode, options: { retryable: boolean; retryAfterMs?: number | null; halt?: boolean; record?: boolean }): Failure {
  return { code, retryable: options.retryable, retryAfterMs: options.retryAfterMs ?? null, halt: options.halt ?? false, record: options.record ?? false };
}

function toOutcome(f: Failure): UploadOutcome {
  return { ok: false, code: f.code, retryable: f.retryable, retryAfterMs: f.retryAfterMs, halt: f.halt };
}

type Terminal = { kind: 'completed' | 'failed'; statusCode: number | null } | { kind: 'timeout' };

interface ParsedEvent {
  name: 'uploading' | 'completed' | 'failed';
  id: string;
  eventId: string | undefined;
  percent: number | null;
  statusCode: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH || UNSAFE_URL_CHARACTERS.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (url.pathname !== UPLOAD_PATH) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'token') return null;
  if (!UPLOAD_TOKEN_PATTERN.test(url.searchParams.get('token') ?? '')) return null;
  return url.href;
}

/** True for exactly `<tenant>/inspections/<inspection>/photos/<pendingId>.<ext>` with this row's ids and extension. */
function isExpectedKey(key: unknown, row: MediaRow): key is string {
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

function clampRetryAfter(ms: number | null): number | null {
  return ms === null ? null : Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS));
}

type StatusClass = { kind: 'success' } | { kind: 'auth' } | { kind: 'failure'; failure: Failure };

/** Maps the HTTP status of the upload to what it means. Only a 2xx is success. */
function classifyStatus(status: number): StatusClass {
  if (status >= 200 && status <= 299) return { kind: 'success' };
  if (status === 401 || status === 403) return { kind: 'auth' };
  if (status === 400 || status === 404 || status === 411 || status === 413 || status === 415 || status === 422) {
    return { kind: 'failure', failure: failure('REJECTED', { retryable: false, record: true }) };
  }
  return { kind: 'failure', failure: failure('SERVER', { retryable: true, record: true }) };
}

type Minted = { ok: true; url: string; key: string } | { ok: false; failure: Failure };

export function createNativeUploader(deps: NativeUploaderDeps): NativeUploader {
  const origin = parseServerUrl(deps.origin, { allowInsecureHttp: deps.allowInsecureHttp === true });
  const timers = deps.timers ?? realTimers;
  const timeoutMs = deps.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;
  const active = new Map<string, Promise<UploadOutcome>>();
  const waiters = new Map<string, { settle(terminal: Terminal): void; pendingId: string; onProgress: ((pendingId: string, percent: number) => void) | undefined }>();
  const early = new Map<string, ParsedEvent>();
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

  async function mint(row: MediaRow): Promise<Minted> {
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
          url: `${origin}/api/inspections/${encodeURIComponent(row.inspectionId)}/media/upload-url`,
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ pendingId: row.pendingId, contentType: row.contentType }),
        });
      } catch (err) {
        if (isAuthError(err) && err.code === 'server_redirected') return { ok: false, failure: failure('BAD_URL', { retryable: true }) };
        return { ok: false, failure: failure('NETWORK', { retryable: true }) };
      }
      if (res.status === 401) {
        if (refreshed) return { ok: false, failure: failure('AUTH', { retryable: true }) };
        refreshed = true;
        try {
          const check = await deps.tokens.checkSession(origin);
          if (check.kind === 'relogin' || check.kind === 'signed_out') return { ok: false, failure: failure('AUTH', { retryable: true, halt: true }) };
        } catch {
          return { ok: false, failure: failure('NETWORK', { retryable: true }) };
        }
        continue;
      }
      if (res.status === 200) return parseMinted(res.json, row);
      if ([400, 403, 404, 411, 413, 415, 422].includes(res.status)) return { ok: false, failure: failure('REJECTED', { retryable: false, record: true }) };
      if (res.status === 426) return { ok: false, failure: failure('UPGRADE', { retryable: true, halt: true }) };
      return { ok: false, failure: failure('SERVER', { retryable: true, retryAfterMs: clampRetryAfter(res.retryAfterMs), record: true }) };
    }
  }

  function parseMinted(body: unknown, row: MediaRow): Minted {
    const bad: Minted = { ok: false, failure: failure('BAD_URL', { retryable: true }) };
    if (!isRecord(body) || body.success !== true || !isRecord(body.data)) return bad;
    const url = resolveUploadUrl(origin, body.data.url);
    const key = body.data.key;
    if (url === null || !isExpectedKey(key, row)) return bad;
    return { ok: true, url, key };
  }

  /** Hands the file to the plugin and waits for the one terminal event that names it. */
  async function runUpload(row: MediaRow, url: string, options: UploadOptions): Promise<Terminal | 'start-failed'> {
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
        serverUrl: url,
        method: 'POST',
        uploadType: 'multipart',
        fileField: 'file',
        mimeType: row.contentType,
        maxRetries: 3,
        headers: { ...deps.clientHeaders },
        notificationTitle: NOTIFICATION_TITLE,
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
    waiters.set(id, { settle, pendingId: row.pendingId, onProgress: options.onProgress });
    const queued = early.get(id);
    if (queued !== undefined && queued.name !== 'uploading') {
      early.delete(id);
      waiters.delete(id);
      acknowledge(queued.eventId);
      settle({ kind: queued.name, statusCode: queued.statusCode });
    }
    starting -= 1;
    dropUnclaimed();
    const timer = timers.setTimeout(() => {
      settle({ kind: 'timeout' });
    }, timeoutMs);
    const terminal = await done;
    timers.clearTimeout(timer);
    waiters.delete(id);
    if (terminal.kind === 'timeout') await deps.plugin.removeUpload({ id }).catch(() => undefined);
    return terminal;
  }

  async function settleFailure(row: MediaRow, f: Failure, counted: boolean): Promise<UploadOutcome> {
    if (f.record || counted) {
      const attempts = f.retryable ? row.attempts + 1 : MAX_UPLOAD_ATTEMPTS;
      try {
        await deps.store.markState(row.pendingId, 'failed', { attempts });
      } catch (error) {
        report(error);
      }
    }
    return toOutcome(f);
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
    if (row === null) return toOutcome(failure('NOT_FOUND', { retryable: false }));
    if (row.inspectionId !== ref.inspectionId) return toOutcome(failure('INVALID', { retryable: false }));
    if (row.kind !== 'photo') return toOutcome(failure('UNSUPPORTED_KIND', { retryable: false }));
    if (row.state === 'uploaded' && row.uploadedKey !== null) return { ok: true, key: row.uploadedKey, reused: true };

    let present: boolean;
    try {
      present = await deps.store.fileExists(row);
    } catch {
      return toOutcome(failure('FILE', { retryable: true }));
    }
    if (!present) return settleFailure(row, failure('FILE', { retryable: false, record: true }), false);
    try {
      await attach();
    } catch {
      return toOutcome(failure('PLUGIN', { retryable: true }));
    }

    let counted = false;
    let refusedOnce = false;
    for (;;) {
      const minted = await mint(row);
      if (!minted.ok) return settleFailure(row, minted.failure, counted);
      // Signing out or locking while the url was being minted must not start the transfer.
      if (await locked()) return settleFailure(row, failure('LOCKED', { retryable: true, halt: true }), counted);
      if (!counted) {
        try {
          if (!(await deps.store.markState(row.pendingId, 'uploading', { attempts: row.attempts + 1 }))) return toOutcome(failure('NOT_FOUND', { retryable: false }));
        } catch (error) {
          report(error);
          return toOutcome(failure('STORE', { retryable: true }));
        }
        counted = true;
      }
      const terminal = await runUpload(row, minted.url, options);
      if (terminal === 'start-failed') return settleFailure(row, failure('FILE', { retryable: true, record: true }), counted);
      if (terminal.kind === 'timeout') return settleFailure(row, failure('TIMEOUT', { retryable: true, record: true }), counted);
      if (terminal.statusCode === null) {
        const code = terminal.kind === 'failed' ? 'NETWORK' : 'SERVER';
        return settleFailure(row, failure(code, { retryable: true, record: true }), counted);
      }
      const verdict = classifyStatus(terminal.statusCode);
      if (verdict.kind === 'success' && terminal.kind === 'completed') {
        try {
          await deps.store.markState(row.pendingId, 'uploaded', { attempts: row.attempts + 1, uploadedKey: minted.key });
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
      if (verdict.kind === 'auth') return settleFailure(row, failure('AUTH', { retryable: true, record: true }), counted);
      if (verdict.kind === 'failure') return settleFailure(row, verdict.failure, counted);
      return settleFailure(row, failure('NETWORK', { retryable: true, record: true }), counted);
    }
  }

  function uploadDetailed(ref: UploadRef, options: UploadOptions = {}): Promise<UploadOutcome> {
    if (!isValidMediaId(ref.pendingId) || !isValidMediaId(ref.inspectionId)) return Promise.resolve(toOutcome(failure('INVALID', { retryable: false })));
    const running = active.get(ref.pendingId);
    if (running) return running;
    const run = doUpload(ref, options)
      .catch((error: unknown): UploadOutcome => {
        report(error);
        return toOutcome(failure('STORE', { retryable: true }));
      })
      .finally(() => {
        active.delete(ref.pendingId);
      });
    active.set(ref.pendingId, run);
    return run;
  }

  return {
    uploadDetailed,
    attach,
    isActive: (pendingId) => active.has(pendingId),
    upload: async (rec) => {
      const outcome = await uploadDetailed({ pendingId: rec.pendingId, inspectionId: rec.inspectionId });
      return outcome.ok ? { ok: true, key: outcome.key } : { ok: false, error: outcome.code };
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
