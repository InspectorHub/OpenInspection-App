/**
 * The main process's restricted HTTP client for the engine's data-package
 * API. Unlike the renderer's `createHttp`, this one retries, understands the
 * `X-Dp-Budget` measurement header and never follows a redirect. Secrets
 * (bearer, X-Data-Job, X-Step-Up-Token) are supplied by the caller as headers;
 * they are only ever passed to a redactor before a log line is emitted, never
 * stored and never built into a URL.
 *
 * The transport is injected so the retry/origin/size logic is testable without
 * a network. `createNodeDataPackageTransport` is the real https/http adapter.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { BudgetHeader } from './config';
import { parseBudgetHeader } from './config';

export const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 3_600_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type DataPackageHttpCode = 'invalid_url' | 'network' | 'timeout' | 'redirect' | 'origin' | 'too_large' | 'auth' | 'server';

export class DataPackageHttpError extends Error {
  readonly code: DataPackageHttpCode;
  constructor(code: DataPackageHttpCode) {
    super(code);
    this.name = 'DataPackageHttpError';
    this.code = code;
  }
}

export interface RawResponse {
  status: number;
  /** The final URL, checked against the requested origin to catch a silent redirect. */
  url: string;
  headers: { get(name: string): string | null };
  body: ArrayBuffer;
}

export interface DataPackageRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Streaming cap: the transport stops reading and rejects `too_large` past this many bytes. */
  maxBytes: number;
  signal: AbortSignal;
}

export type RequestLike = (req: DataPackageRequest) => Promise<RawResponse>;

export interface RetryOpts {
  attempt: number;
  maxAttempts: number;
  random: () => number;
}

export type RetryDecision =
  | { kind: 'retry'; delayMs: number }
  | { kind: 'stop'; reason: 'ok' | 'relogin' | 'fatal' };

function backoffMs(attempt: number, random: () => number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
  return Math.round(exponential * (0.5 + 0.5 * random()));
}

/** Retry only transport-throttling and 5xx answers; 2xx succeeds, auth failures end the session, everything else is fatal. */
export function classifyRetry(status: number, retryAfterMs: number | null, opts: RetryOpts): RetryDecision {
  if (status >= 200 && status < 300) return { kind: 'stop', reason: 'ok' };
  if (status === 401 || status === 403) return { kind: 'stop', reason: 'relogin' };
  const retryable = status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  if (!retryable || opts.attempt >= opts.maxAttempts) return { kind: 'stop', reason: 'fatal' };
  const delayMs = retryAfterMs !== null && retryAfterMs > 0
    ? Math.min(retryAfterMs, MAX_RETRY_AFTER_MS)
    : backoffMs(opts.attempt, opts.random);
  return { kind: 'retry', delayMs };
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Math.min(Number(value.trim()) * 1000, MAX_RETRY_AFTER_MS);
}

function decode(body: ArrayBuffer): { text: string; json: unknown } {
  const text = new TextDecoder().decode(body);
  let json: unknown;
  try { json = text === '' ? undefined : JSON.parse(text) as unknown; } catch { json = undefined; }
  return { text, json };
}

export interface HttpTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface DataPackageHttpDeps {
  request: RequestLike;
  log?: (line: string) => void;
  redact?: (text: string) => string;
  /** Injectable so tests can disable the abort timer; production uses real timers. */
  timers?: HttpTimers;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface OutgoingRequest {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface DataPackageResponse {
  status: number;
  text: string;
  json: unknown;
  budget: BudgetHeader | null;
  retryAfterMs: number | null;
}

/** The restricted client surface consumed by the export runner. */
export type DataPackageHttp = { request(req: OutgoingRequest): Promise<DataPackageResponse> };

const realTimers: HttpTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A single request with bounded retries. Each attempt re-checks origin and
 * size, and every emitted log line goes through the injected redactor.
 */
export function createDataPackageHttp(deps: DataPackageHttpDeps): { request(req: OutgoingRequest): Promise<DataPackageResponse> } {
  const redact = deps.redact ?? ((s: string) => s);
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? realSleep;
  const timers = deps.timers ?? realTimers;

  return {
    async request(req) {
      let expectedOrigin: string;
      try {
        const url = new URL(req.url);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
        expectedOrigin = url.origin;
      } catch {
        throw new DataPackageHttpError('invalid_url');
      }
      const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      for (let attempt = 1; ; attempt++) {
        const controller = new AbortController();
        const timer = timers.setTimeout(() => controller.abort(), timeoutMs);
        let raw: RawResponse;
        try {
          raw = await deps.request({
            url: req.url, method: req.method, headers: { ...req.headers },
            ...(req.body === undefined ? {} : { body: req.body }),
            timeoutMs, maxBytes, signal: controller.signal,
          });
        } catch (error) {
          // Preserve an explicit transport verdict (e.g. too_large); a timed-out
          // request maps to timeout, any other transport failure to network.
          if (error instanceof DataPackageHttpError) throw error;
          throw new DataPackageHttpError(controller.signal.aborted ? 'timeout' : 'network');
        } finally {
          timers.clearTimeout(timer);
        }

        if (raw.status >= 300 && raw.status < 400) throw new DataPackageHttpError('redirect');
        let actualOrigin: string;
        try { actualOrigin = new URL(raw.url).origin; } catch { throw new DataPackageHttpError('origin'); }
        if (actualOrigin !== expectedOrigin) throw new DataPackageHttpError('origin');
        if (raw.body.byteLength > maxBytes) throw new DataPackageHttpError('too_large');

        deps.log?.(redact(`${req.method} ${req.url} ${raw.status}`));
        const retryAfterMs = parseRetryAfter(raw.headers.get('retry-after'));
        const decision = classifyRetry(raw.status, retryAfterMs, { attempt, maxAttempts: MAX_ATTEMPTS, random });
        if (decision.kind === 'retry') {
          await sleep(decision.delayMs);
          continue;
        }
        if (decision.reason === 'relogin') throw new DataPackageHttpError('auth');
        if (decision.reason === 'fatal') throw new DataPackageHttpError('server');
        return {
          status: raw.status,
          ...decode(raw.body),
          budget: parseBudgetHeader(raw.headers.get('x-dp-budget')),
          retryAfterMs,
        };
      }
    },
  };
}

/** The real node http/https transport. Callers own credential headers and the abort signal. */
export function createNodeDataPackageTransport(): RequestLike {
  return (input) => new Promise<RawResponse>((resolve, reject) => {
    let url: URL;
    try { url = new URL(input.url); } catch { reject(new DataPackageHttpError('invalid_url')); return; }
    const send = url.protocol === 'https:' ? httpsRequest : url.protocol === 'http:' ? httpRequest : null;
    if (send === null) { reject(new DataPackageHttpError('invalid_url')); return; }
    let req: ReturnType<typeof httpRequest> | undefined;
    const abort = (): void => { req?.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })); };
    req = send(url, { method: input.method, headers: input.headers }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let overCap = false;
      res.on('data', (chunk: Buffer) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > input.maxBytes) {
          overCap = true;
          input.signal.removeEventListener('abort', abort);
          res.destroy();
          req?.destroy();
          reject(new DataPackageHttpError('too_large'));
          return;
        }
        chunks.push(bytes);
      });
      res.on('end', () => {
        if (overCap) return;
        input.signal.removeEventListener('abort', abort);
        const body = Buffer.concat(chunks);
        resolve({
          status: res.statusCode ?? 0,
          url: `${url.origin}${url.pathname}`,
          headers: { get: (name) => {
            const value = res.headers[name.toLowerCase()];
            return Array.isArray(value) ? value[0] ?? null : value ?? null;
          } },
          body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
        });
      });
      res.on('error', () => { if (!overCap) reject(new DataPackageHttpError('network')); });
    });
    req.once('error', reject);
    if (input.signal.aborted) abort();
    else input.signal.addEventListener('abort', abort, { once: true });
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}
