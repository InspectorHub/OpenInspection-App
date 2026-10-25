import { safeClientHeaders } from '../auth/client-headers';
import { AuthError } from '../auth/errors';
import type { Http, HttpResponse } from '../auth/http';
import type { TokenManager } from '../auth/tokens';
import { isLocalId } from '../offline/registry';

/**
 * The editor's online writes: one Bearer request at a time through the app's authenticated wrapper (pinned origin, no
 * redirects, bounded time and size, no credentials cookie). A 401 is checked with the token manager and asked again
 * once, as the other clients do. An HTTP error status is an answer; only the things that stop an answer from arriving
 * are problems.
 */

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface ApiCall {
  method: ApiMethod;
  /** An `/api/...` path built with `apiPath`. */
  path: string;
  json?: unknown;
  /** An upload. The platform sets the multipart content type. */
  form?: FormData;
  /** Sent as `Idempotency-Key`, for the writes that would duplicate a record if repeated. */
  idempotencyKey?: string;
  timeoutMs?: number;
}

export type ApiProblem = 'offline' | 'timeout' | 'auth' | 'upgrade';

export type ApiOutcome = { kind: 'response'; status: number; json: unknown } | { kind: 'problem'; problem: ApiProblem };

export interface Api {
  send(call: ApiCall): Promise<ApiOutcome>;
}

export interface ApiClientDeps {
  http: Http;
  tokens: Pick<TokenManager, 'getAccessToken' | 'checkSession'>;
  /** The stored, canonical server origin: the only host a request is sent to. */
  origin: string;
  /** `X-Client-Platform` and `X-Client-Version`. Credential, content-type and idempotency headers cannot be set from here. */
  clientHeaders?: Record<string, string>;
  /** Asked right before every request; false (or a throw) means nothing is sent (the device is locked). */
  gate?: () => boolean | Promise<boolean>;
}

/** The longest an answer may be. The editor's writes answer a few lines; this only bounds a hostile one. */
const RESPONSE_MAX_BYTES = 1_048_576;
const JSON_TIMEOUT_MS = 20_000;
const FORM_TIMEOUT_MS = 90_000;

/** `/api/inspections/<id>/<segments...>`. The id is checked and every segment encoded, so no text becomes part of the path unescaped. */
export function apiPath(inspectionId: string, ...segments: string[]): string {
  if (!isLocalId(inspectionId)) throw new RangeError('invalid inspection id');
  return ['/api/inspections', encodeURIComponent(inspectionId), ...segments.map((segment) => encodeURIComponent(segment))].join('/');
}

async function open(gate: ApiClientDeps['gate']): Promise<boolean> {
  if (gate === undefined) return true;
  try {
    return await gate();
  } catch {
    return false;
  }
}

export function createApiClient(deps: ApiClientDeps): Api {
  const clientHeaders = safeClientHeaders(deps.clientHeaders ?? {}, ['content-type', 'idempotency-key']);

  async function send(call: ApiCall): Promise<ApiOutcome> {
    if (!call.path.startsWith('/api/')) throw new RangeError('api paths start with /api/');
    let refreshed = false;
    for (;;) {
      let token: string | null;
      try {
        token = await deps.tokens.getAccessToken(deps.origin);
      } catch {
        return { kind: 'problem', problem: 'offline' };
      }
      if (token === null) return { kind: 'problem', problem: 'auth' };
      // The lock can arrive while the token is being read, so it is asked after.
      if (!(await open(deps.gate))) return { kind: 'problem', problem: 'auth' };

      const headers: Record<string, string> = { ...clientHeaders, Authorization: `Bearer ${token}` };
      if (call.json !== undefined) headers['content-type'] = 'application/json';
      if (call.idempotencyKey !== undefined) headers['Idempotency-Key'] = call.idempotencyKey;

      let res: HttpResponse;
      try {
        res = await deps.http.request({
          url: `${deps.origin}${call.path}`,
          method: call.method,
          headers,
          ...(call.form !== undefined ? { form: call.form } : call.json !== undefined ? { body: JSON.stringify(call.json) } : {}),
          timeoutMs: call.timeoutMs ?? (call.form !== undefined ? FORM_TIMEOUT_MS : JSON_TIMEOUT_MS),
          maxBytes: RESPONSE_MAX_BYTES,
        });
      } catch (error) {
        return { kind: 'problem', problem: error instanceof AuthError && error.code === 'server_timeout' ? 'timeout' : 'offline' };
      }

      if (res.status === 426) return { kind: 'problem', problem: 'upgrade' };
      if (res.status !== 401) return { kind: 'response', status: res.status, json: res.json };
      if (refreshed) return { kind: 'problem', problem: 'auth' };
      refreshed = true;
      try {
        const session = await deps.tokens.checkSession(deps.origin);
        if (session.kind === 'relogin' || session.kind === 'signed_out') return { kind: 'problem', problem: 'auth' };
        if (session.kind === 'retry') return { kind: 'problem', problem: 'offline' };
      } catch {
        return { kind: 'problem', problem: 'offline' };
      }
    }
  }

  return { send };
}
