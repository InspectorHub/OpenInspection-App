import { describe, expect, it } from 'vitest';
import {
  classifyRetry,
  createDataPackageHttp,
  DataPackageHttpError,
  MAX_ATTEMPTS,
  type RawResponse,
  type RequestLike,
} from './http';
import { parseBudgetHeader } from './config';

const ORIGIN = 'https://app.example.test';
const URL_OK = `${ORIGIN}/api/admin/data-package/jobs`;
const BUDGET = 'reads=0/0;writes=0/0;profile=worker-free;pageRows=48;pageBytes=98304';

function response(overrides: Partial<RawResponse> = {}): RawResponse {
  const body = new TextEncoder().encode(JSON.stringify({ success: true, data: { ok: 1 } })).buffer;
  return {
    status: 200,
    url: URL_OK,
    headers: { get: (name: string) => (name.toLowerCase() === 'x-dp-budget' ? BUDGET : null) },
    body,
    ...overrides,
  };
}

function request(impl: (call: number) => RawResponse | Promise<RawResponse>): { fn: RequestLike; calls: number } {
  let calls = 0;
  return { fn: () => Promise.resolve(impl(++calls)), get calls() { return calls; } };
}

const noTimers = { setTimeout: () => ({ unref() {} }) as unknown as ReturnType<typeof setTimeout>, clearTimeout: () => {} };

describe('data-package http: retry classification (pure)', () => {
  it('stops on success and on auth failures, retries throttling/5xx only', () => {
    const base = { attempt: 1, maxAttempts: MAX_ATTEMPTS, random: () => 0.5 };
    expect(classifyRetry(200, null, base).kind).toBe('stop');
    expect(classifyRetry(401, null, base)).toMatchObject({ kind: 'stop', reason: 'relogin' });
    expect(classifyRetry(403, null, base)).toMatchObject({ kind: 'stop', reason: 'relogin' });
    expect(classifyRetry(400, null, base)).toMatchObject({ kind: 'stop', reason: 'fatal' });
    expect(classifyRetry(404, null, base)).toMatchObject({ kind: 'stop', reason: 'fatal' });
    expect(classifyRetry(500, null, base).kind).toBe('retry');
    expect(classifyRetry(429, 2000, base)).toMatchObject({ kind: 'retry', delayMs: 2000 });
    expect(classifyRetry(503, null, base).kind).toBe('retry');
  });

  it('honours Retry-After over backoff and stops when attempts are exhausted', () => {
    expect(classifyRetry(429, 3000, { attempt: 1, maxAttempts: 5, random: () => 0.5 })).toMatchObject({ delayMs: 3000 });
    expect(classifyRetry(500, null, { attempt: 5, maxAttempts: 5, random: () => 0.5 })).toMatchObject({ kind: 'stop', reason: 'fatal' });
  });
});

describe('data-package http: request wrapper', () => {
  it('returns parsed JSON plus the budget header, and logs only method/path/status', async () => {
    const lines: string[] = [];
    const http = createDataPackageHttp({
      request: request(() => response()).fn,
      log: (line) => lines.push(line),
      redact: (s) => s,
      timers: noTimers,
      random: () => 0.5,
    });
    const res = await http.request({
      url: URL_OK, method: 'POST',
      headers: { Authorization: 'Bearer SECRET', 'X-Data-Job': 'JOBSECRET' },
      body: '{"kind":"export"}',
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ success: true, data: { ok: 1 } });
    expect(res.budget).toEqual(parseBudgetHeader(BUDGET));
    expect(lines.join('\n')).toContain('/api/admin/data-package/jobs');
    expect(lines.join('\n')).not.toContain('SECRET');
  });

  it('rejects a redirect and a cross-origin answer', async () => {
    const redirect = createDataPackageHttp({ request: request(() => response({ status: 302 })).fn, timers: noTimers, redact: (s) => s });
    await expect(redirect.request({ url: URL_OK, method: 'GET' })).rejects.toMatchObject({ code: 'redirect' });
    const cross = createDataPackageHttp({ request: request(() => response({ url: 'https://evil.test/x' })).fn, timers: noTimers, redact: (s) => s });
    await expect(cross.request({ url: URL_OK, method: 'GET' })).rejects.toMatchObject({ code: 'origin' });
  });

  it('retries a 500 then succeeds, bounded by MAX_ATTEMPTS', async () => {
    const r = request((call) => (call < 3 ? response({ status: 503 }) : response()));
    const http = createDataPackageHttp({ request: r.fn, timers: noTimers, redact: (s) => s, random: () => 0.5 });
    const res = await http.request({ url: URL_OK, method: 'GET' });
    expect(res.status).toBe(200);
    expect(r.calls).toBe(3);

    const always = request(() => response({ status: 500 }));
    const http2 = createDataPackageHttp({ request: always.fn, timers: noTimers, redact: (s) => s, random: () => 0.5 });
    await expect(http2.request({ url: URL_OK, method: 'GET' })).rejects.toBeInstanceOf(DataPackageHttpError);
    expect(always.calls).toBe(MAX_ATTEMPTS);
  });

  it('rejects a non-http url and an oversized body', async () => {
    const http = createDataPackageHttp({ request: request(() => response()).fn, timers: noTimers, redact: (s) => s });
    await expect(http.request({ url: 'file:///etc/passwd', method: 'GET' })).rejects.toMatchObject({ code: 'invalid_url' });
    const big = new TextEncoder().encode('x'.repeat(200)).buffer;
    const http2 = createDataPackageHttp({ request: request(() => response({ body: big })).fn, timers: noTimers, redact: (s) => s });
    await expect(http2.request({ url: URL_OK, method: 'GET', maxBytes: 10 })).rejects.toMatchObject({ code: 'too_large' });
  });

  it('maps a transport rejection to network, and an aborted request to timeout', async () => {
    const failing: RequestLike = () => Promise.reject(new Error('socket hang up'));
    const http = createDataPackageHttp({ request: failing, timers: noTimers, redact: (s) => s });
    await expect(http.request({ url: URL_OK, method: 'GET' })).rejects.toMatchObject({ code: 'network' });

    // Real timers + a request that settles only when the wrapper aborts it: exercises the timeout branch.
    const aborts: RequestLike = ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    const http2 = createDataPackageHttp({ request: aborts, redact: (s) => s });
    await expect(http2.request({ url: URL_OK, method: 'GET', timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('re-logs through the injected redactor so header secrets never reach the log', async () => {
    const lines: string[] = [];
    const http = createDataPackageHttp({
      request: () => Promise.resolve(response({ url: `${URL_OK}?code=CALLSECRET` })),
      log: (line) => lines.push(line),
      redact: (s) => s.replace(/CALLSECRET/g, '[redacted]'),
      timers: noTimers,
    });
    await http.request({ url: URL_OK, method: 'GET' });
    expect(lines.join('\n')).not.toContain('CALLSECRET');
  });
});
