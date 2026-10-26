import { safeClientHeaders } from '../auth/client-headers';
import { AuthError } from '../auth/errors';
import type { Http, HttpResponse } from '../auth/http';
import { fetchSession, parseServerUrl } from '../auth/server-config';
import type { TokenManager } from '../auth/tokens';
import type { Clock } from '../platform/clock';
import { LOCAL_ID_PATTERN } from './registry';

/**
 * The client of `POST /api/client/inspections/visible`: "which of these inspection ids does the server still show
 * this member?". Its answer decides whether a device may remove an inspector's local copy, so everything that is not
 * a complete, well-formed answer to EVERY batch is a non-answer with a fixed code, and a non-answer never carries
 * a visible set. Nothing here logs, and nothing it returns contains a token, an id or any text the server sent.
 *
 *  - Ids travel in the request body only; the body holds the key `ids` and nothing else.
 *  - Batches of at most `min(300, maxBatch)`. A 422 that states a smaller `details.limits.ids` shrinks the batch ONCE and
 *    asks again; a second 422 gives up. A 422 is never data.
 *  - A failing batch ends the whole run. The caller decides only after every batch succeeded (two phases).
 *  - A 2xx is trusted only if it is JSON, `success === true`, and `data.visible` is an array of unique ids of the
 *    allowed charset that are ALL members of the batch that was asked. A superset, a foreign id, a duplicate or any other
 *    shape is a protocol violation (`invalid`), never "everything is missing".
 */

export const VISIBLE_PATH = '/api/client/inspections/visible';
/** The engine's default limit; its operators may only lower it for a deployment, so this is the ceiling of any batch. */
export const VISIBLE_MAX_IDS = 300;
/** Requests of one run: far above 5000 ids in 300-id batches, far below a loop. */
export const DEFAULT_MAX_REQUESTS = 100;
/** The answer is a list of ids; a body larger than this is not one. */
const RESPONSE_MAX_BYTES = 262_144;
const JSON_CONTENT_TYPE = /^application\/json\s*(?:;|$)/i;

export type VisibleFailure = 'network' | 'timeout' | 'rate_limited' | 'server' | 'rejected' | 'limit' | 'auth_retry' | 'time_budget' | 'too_many_requests';

export type VisibleOutcome =
  | { kind: 'ok'; visible: ReadonlySet<string>; requested: number; requests: number }
  /** This member's role may not ask (office staff). Not an error, and never a reason to remove anything. */
  | { kind: 'unavailable'; reason: 'role' | 'unsupported' }
  /** The session is over or needs a new sign-in. No data changes. */
  | { kind: 'auth' }
  /** The server needs a newer app. */
  | { kind: 'halt'; reason: 'upgrade_required' }
  /** The gate closed (locked, revoked, lease lost): the request was not sent. */
  | { kind: 'blocked' }
  | { kind: 'failed'; reason: VisibleFailure; retryAfterMs: number | null }
  | { kind: 'invalid'; reason: 'bad_ids' | 'bad_response' };

export interface VisibleCheckOptions {
  /** Asked right before EVERY request, after the token was read; false (or a throw) means the request is not sent. */
  gate?: () => boolean | Promise<boolean>;
  /** A smaller batch than the default, never a larger one. */
  maxBatch?: number;
  maxRequests?: number;
  /** With `clock`: no request starts once `clock.now()` has passed this instant. */
  deadlineAt?: number;
  clock?: Clock;
}

export interface VisibleClient {
  check(ids: readonly string[], options?: VisibleCheckOptions): Promise<VisibleOutcome>;
}

export interface VisibleClientDeps {
  /** The authenticated wrapper: pinned origin, no redirects, bounded time and size. */
  http: Http;
  tokens: Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  /** The stored, canonical server origin. */
  origin: string;
  allowInsecureHttp?: boolean;
  /** `X-Client-Platform` and `X-Client-Version`. Credentials and the content type cannot be set from here. */
  clientHeaders?: Record<string, string>;
}

function assertOrigin(deps: { origin: string; allowInsecureHttp?: boolean }): void {
  const options = deps.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: deps.allowInsecureHttp };
  if (parseServerUrl(deps.origin, options) !== deps.origin) throw new AuthError('invalid_server_url');
}

function limitStated(res: HttpResponse): number | null {
  const body = res.json;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = body.error;
  if (typeof error !== 'object' || error === null || !('details' in error)) return null;
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('limits' in details)) return null;
  const limits = details.limits;
  if (typeof limits !== 'object' || limits === null || !('ids' in limits)) return null;
  const ids = limits.ids;
  return typeof ids === 'number' && Number.isInteger(ids) && ids >= 1 && ids <= VISIBLE_MAX_IDS ? ids : null;
}

/** The ids of a well-formed answer to `batch`, or null for anything else. */
function parseAnswer(res: HttpResponse, batch: ReadonlySet<string>): string[] | null {
  if (res.status < 200 || res.status > 299) return null;
  if (!JSON_CONTENT_TYPE.test(res.headers.get('content-type') ?? '')) return null;
  const body = res.json;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  if (!('success' in body) || body.success !== true || !('data' in body)) return null;
  const data = body.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !('visible' in data)) return null;
  const visible = data.visible;
  if (!Array.isArray(visible) || visible.length > batch.size) return null;
  const seen = new Set<string>();
  for (const id of visible as unknown[]) {
    if (typeof id !== 'string' || !LOCAL_ID_PATTERN.test(id) || !batch.has(id) || seen.has(id)) return null;
    seen.add(id);
  }
  return [...seen];
}

function failureOf(error: unknown): VisibleFailure {
  return error instanceof AuthError && error.code === 'server_timeout' ? 'timeout' : 'network';
}

type Sent = { kind: 'response'; res: HttpResponse } | { kind: 'outcome'; outcome: VisibleOutcome };

export function createVisibleClient(deps: VisibleClientDeps): VisibleClient {
  assertOrigin(deps);
  const url = `${deps.origin}${VISIBLE_PATH}`;
  const clientHeaders = safeClientHeaders(deps.clientHeaders ?? {}, ['content-type']);

  async function allowed(gate: VisibleCheckOptions['gate']): Promise<boolean> {
    if (gate === undefined) return true;
    try {
      return await gate();
    } catch {
      return false;
    }
  }

  async function check(input: readonly string[], options: VisibleCheckOptions = {}): Promise<VisibleOutcome> {
    const unique = [...new Set(input)];
    if (unique.some((id) => !LOCAL_ID_PATTERN.test(id))) return { kind: 'invalid', reason: 'bad_ids' };
    const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
    let size = Math.max(1, Math.min(VISIBLE_MAX_IDS, Math.floor(options.maxBatch ?? VISIBLE_MAX_IDS)));
    let shrunk = false;
    let requests = 0;
    const visible = new Set<string>();

    /** One authenticated request. A 401 is checked with the token manager once and, if the session holds, asked again once. */
    async function send(batch: readonly string[]): Promise<Sent> {
      let refreshed = false;
      for (;;) {
        if (options.clock !== undefined && options.deadlineAt !== undefined && options.clock.now() > options.deadlineAt) {
          return { kind: 'outcome', outcome: { kind: 'failed', reason: 'time_budget', retryAfterMs: null } };
        }
        if (requests >= maxRequests) return { kind: 'outcome', outcome: { kind: 'failed', reason: 'too_many_requests', retryAfterMs: null } };
        let token: string | null;
        try {
          token = await deps.tokens.getAccessToken(deps.origin);
        } catch {
          return { kind: 'outcome', outcome: { kind: 'failed', reason: 'network', retryAfterMs: null } };
        }
        if (token === null) return { kind: 'outcome', outcome: { kind: 'auth' } };
        // What was true before the token was read is checked again right before the request: the lock can arrive meanwhile.
        if (!(await allowed(options.gate))) return { kind: 'outcome', outcome: { kind: 'blocked' } };
        requests += 1;
        let res: HttpResponse;
        try {
          res = await deps.http.request({
            url,
            method: 'POST',
            headers: { ...clientHeaders, Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ids: batch }),
            maxBytes: RESPONSE_MAX_BYTES,
          });
        } catch (error) {
          return { kind: 'outcome', outcome: { kind: 'failed', reason: failureOf(error), retryAfterMs: null } };
        }
        if (res.status !== 401) return { kind: 'response', res };
        if (refreshed) return { kind: 'outcome', outcome: { kind: 'auth' } };
        refreshed = true;
        try {
          const session = await deps.tokens.checkSession(deps.origin);
          if (session.kind === 'relogin' || session.kind === 'signed_out') return { kind: 'outcome', outcome: { kind: 'auth' } };
          if (session.kind === 'retry') return { kind: 'outcome', outcome: { kind: 'failed', reason: 'auth_retry', retryAfterMs: session.retryAfterMs } };
        } catch {
          return { kind: 'outcome', outcome: { kind: 'failed', reason: 'network', retryAfterMs: null } };
        }
      }
    }

    let offset = 0;
    while (offset < unique.length) {
      const batch = unique.slice(offset, offset + size);
      const sent = await send(batch);
      if (sent.kind === 'outcome') return sent.outcome;
      const { res } = sent;
      const status = res.status;
      if (status === 403) return { kind: 'unavailable', reason: 'role' };
      // A server too old to have the route answers 404 (or 405): the check does not exist there. Never a reason to remove anything.
      if (status === 404 || status === 405) return { kind: 'unavailable', reason: 'unsupported' };
      if (status === 426) return { kind: 'halt', reason: 'upgrade_required' };
      if (status === 422) {
        const limit = limitStated(res);
        if (!shrunk && limit !== null && limit < batch.length) {
          shrunk = true;
          size = limit;
          continue;
        }
        return { kind: 'failed', reason: 'limit', retryAfterMs: null };
      }
      if (status === 429) return { kind: 'failed', reason: 'rate_limited', retryAfterMs: res.retryAfterMs };
      if (status === 408 || status >= 500) return { kind: 'failed', reason: 'server', retryAfterMs: res.retryAfterMs };
      if (status < 200 || status > 299) return { kind: 'failed', reason: 'rejected', retryAfterMs: null };
      const answered = parseAnswer(res, new Set(batch));
      if (answered === null) return { kind: 'invalid', reason: 'bad_response' };
      for (const id of answered) visible.add(id);
      offset += batch.length;
    }
    return { kind: 'ok', visible, requested: unique.length, requests };
  }

  return { check };
}

export type SessionProbeResult =
  | { kind: 'ok'; userId: string; tenantId: string; role: string }
  | { kind: 'auth' }
  | { kind: 'failed' }
  | { kind: 'invalid' };

export interface SessionProbe {
  check(options?: { gate?: () => boolean | Promise<boolean> }): Promise<SessionProbeResult>;
}

/**
 * `GET /api/client/session`: who the server believes is signed in on this device. A reconcile binds itself to this
 * identity before it sends a single id, because a token for another company or environment gets a perfectly valid
 * answer to a question about somebody else's inspections.
 */
export function createSessionProbe(deps: Omit<VisibleClientDeps, 'clientHeaders'>): SessionProbe {
  assertOrigin(deps);
  return {
    check: async (options = {}) => {
      let refreshed = false;
      for (;;) {
        let token: string | null;
        try {
          token = await deps.tokens.getAccessToken(deps.origin);
        } catch {
          return { kind: 'failed' };
        }
        if (token === null) return { kind: 'auth' };
        if (options.gate !== undefined) {
          let open: boolean;
          try {
            open = await options.gate();
          } catch {
            open = false;
          }
          if (!open) return { kind: 'failed' };
        }
        try {
          const result = await fetchSession(deps.http, deps.origin, token);
          if (result.kind === 'ok') return { kind: 'ok', userId: result.session.userId, tenantId: result.session.tenantId, role: result.session.role };
        } catch (error) {
          return error instanceof AuthError && error.code === 'server_response_invalid' ? { kind: 'invalid' } : { kind: 'failed' };
        }
        if (refreshed) return { kind: 'auth' };
        refreshed = true;
        try {
          const session = await deps.tokens.checkSession(deps.origin);
          if (session.kind === 'relogin' || session.kind === 'signed_out') return { kind: 'auth' };
          if (session.kind === 'retry') return { kind: 'failed' };
        } catch {
          return { kind: 'failed' };
        }
      }
    },
  };
}
