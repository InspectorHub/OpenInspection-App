import { AuthError } from './errors';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_RETRY_AFTER_MS = 3_600_000;

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  /** The parsed body, or `undefined` when it is empty or not JSON. */
  json: unknown;
  retryAfterMs: number | null;
  /** The `X-Client-Upgrade` header, when the server sent one. */
  upgrade: string | null;
}

export interface Http {
  request(req: HttpRequest): Promise<HttpResponse>;
}

export interface HttpDeps {
  fetch: FetchLike;
  /** Sent on every request, for example the client platform and version. */
  defaultHeaders?: Record<string, string>;
  defaultTimeoutMs?: number;
  defaultMaxBytes?: number;
  /** Called with the `X-Client-Upgrade` value of every response that carries one. */
  onUpgrade?: (status: string) => void;
  /** Receives one redacted line per request. */
  log?: (line: string) => void;
}

const SECRET_PARAMS = /\b(refresh_token|access_token|id_token|code_verifier|code|state|client_secret|token)=[^&\s"']*/g;

/** Removes bearer tokens and token-like parameters from text that may be logged. */
export function redact(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(SECRET_PARAMS, '$1=[redacted]');
}

/** Scheme, host and path only: no query, no fragment, no credentials. */
export function safeUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? `${u.protocol}${u.pathname}` : `${u.origin}${u.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}

/** Delta-seconds only; an HTTP-date would need the server's clock, which is never trusted. */
export function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

function sameOrigin(responseUrl: string, expected: string): boolean {
  try {
    return new URL(responseUrl).origin === expected;
  } catch {
    return false;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.body?.cancel().catch(() => undefined);
    throw new AuthError('server_response_invalid');
  }
  if (!response.body) {
    const whole = await response.text();
    if (whole.length > maxBytes) throw new AuthError('server_response_invalid');
    return whole;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new AuthError('server_response_invalid');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * The one fetch wrapper every auth call goes through. It never follows a
 * redirect (any 3xx is a failure), insists the answer came from the origin it
 * asked, bounds both time and size, and turns every failure into an
 * `AuthError` that carries no text from the network.
 */
export function createHttp(deps: HttpDeps): Http {
  return {
    request: async (req) => {
      const expectedOrigin = new URL(req.url).origin;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, req.timeoutMs ?? deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        let response: Response;
        try {
          response = await deps.fetch(req.url, {
            method: req.method,
            headers: { ...deps.defaultHeaders, ...req.headers },
            body: req.body,
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
          });
        } catch {
          throw new AuthError(timedOut ? 'server_timeout' : 'server_unreachable');
        }
        if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          response.body?.cancel().catch(() => undefined);
          throw new AuthError('server_redirected');
        }
        if (response.url && !sameOrigin(response.url, expectedOrigin)) {
          response.body?.cancel().catch(() => undefined);
          throw new AuthError('server_redirected');
        }
        let text: string;
        try {
          text = await readCapped(response, req.maxBytes ?? deps.defaultMaxBytes ?? DEFAULT_MAX_BYTES);
        } catch (err) {
          if (err instanceof AuthError) throw err;
          throw new AuthError(timedOut ? 'server_timeout' : 'server_unreachable');
        }
        const upgrade = response.headers.get('x-client-upgrade');
        if (upgrade !== null) deps.onUpgrade?.(upgrade);
        deps.log?.(`${req.method} ${safeUrlForLog(req.url)} ${String(response.status)}`);
        return {
          status: response.status,
          headers: response.headers,
          text,
          json: parseJson(text),
          retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
          upgrade,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
