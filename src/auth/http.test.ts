import { describe, expect, it, vi } from 'vitest';
import { isAuthError } from './errors';
import { createHttp, parseRetryAfter, parseServerDate, redact, safeUrlForLog, type FetchLike } from './http';

const ORIGIN = 'https://oi.example.test';

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function withUrl(response: Response, url: string): Response {
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAuthError(err)) return err.code;
    throw err;
  }
  return 'resolved';
}

describe('http wrapper: redirects (P0-3)', () => {
  it('asks fetch not to follow redirects', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(ok()));
    await createHttp({ fetch }).request({ url: `${ORIGIN}/a`, method: 'GET' });
    expect(fetch.mock.calls[0]?.[1].redirect).toBe('manual');
  });

  it.each([301, 302, 303, 307, 308])('treats a %i as failure and makes no second request', async (status) => {
    const fetch = vi.fn<FetchLike>(() =>
      Promise.resolve(new Response('', { status, headers: { location: 'https://evil.example.test/steal' } })),
    );
    expect(await codeOf(createHttp({ fetch }).request({ url: `${ORIGIN}/oauth/token`, method: 'POST', body: 'x=1' }))).toBe('server_redirected');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('treats an opaque redirect as failure', async () => {
    const opaque = new Response('', { status: 200 });
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' });
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(opaque));
    expect(await codeOf(createHttp({ fetch }).request({ url: `${ORIGIN}/a`, method: 'GET' }))).toBe('server_redirected');
  });

  it('rejects a response whose final url is on another origin (positive control: same origin passes)', async () => {
    const hostile = createHttp({ fetch: () => Promise.resolve(withUrl(ok(), 'https://evil.example.test/a')) });
    expect(await codeOf(hostile.request({ url: `${ORIGIN}/a`, method: 'GET' }))).toBe('server_redirected');
    const same = createHttp({ fetch: () => Promise.resolve(withUrl(ok(), `${ORIGIN}/a`)) });
    expect((await same.request({ url: `${ORIGIN}/a`, method: 'GET' })).status).toBe(200);
  });
});

describe('http wrapper: timeout, size, errors', () => {
  it('aborts a hanging request with a timeout error', async () => {
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    expect(await codeOf(createHttp({ fetch }).request({ url: `${ORIGIN}/a`, method: 'GET', timeoutMs: 20 }))).toBe('server_timeout');
  });

  it('caps the body: over the cap fails, under the cap passes', async () => {
    const big = (): Promise<Response> => Promise.resolve(new Response('x'.repeat(2000), { status: 200 }));
    const http = createHttp({ fetch: big });
    expect(await codeOf(http.request({ url: `${ORIGIN}/a`, method: 'GET', maxBytes: 1000 }))).toBe('server_response_invalid');
    const res = await http.request({ url: `${ORIGIN}/a`, method: 'GET', maxBytes: 4000 });
    expect(res.text.length).toBe(2000);
  });

  it('refuses early on a declared content-length over the cap', async () => {
    const fetch: FetchLike = () => Promise.resolve(new Response('tiny', { status: 200, headers: { 'content-length': '999999' } }));
    expect(await codeOf(createHttp({ fetch }).request({ url: `${ORIGIN}/a`, method: 'GET', maxBytes: 1000 }))).toBe('server_response_invalid');
  });

  it('maps a network failure to a fixed error that carries none of the original text', async () => {
    const http = createHttp({ fetch: () => Promise.reject(new TypeError('connect ECONNREFUSED https://oi.example.test/?code=SECRET')) });
    try {
      await http.request({ url: `${ORIGIN}/a?code=SECRET`, method: 'GET' });
      expect.unreachable();
    } catch (err) {
      expect(isAuthError(err) && err.code).toBe('server_unreachable');
      const shown = String((err as Error).message) + String((err as Error).stack) + JSON.stringify(err);
      expect(shown).not.toContain('SECRET');
    }
  });

  it('parses json when valid and leaves it undefined when not', async () => {
    const good = await createHttp({ fetch: () => Promise.resolve(ok({ a: 1 })) }).request({ url: `${ORIGIN}/a`, method: 'GET' });
    expect(good.json).toEqual({ a: 1 });
    const bad = await createHttp({ fetch: () => Promise.resolve(new Response('<html>', { status: 200 })) }).request({ url: `${ORIGIN}/a`, method: 'GET' });
    expect(bad.json).toBeUndefined();
  });

  it('sends default headers on every call and reports X-Client-Upgrade', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'x-client-upgrade': 'required' } })));
    const onUpgrade = vi.fn();
    const http = createHttp({ fetch, onUpgrade, defaultHeaders: { 'X-Client-Platform': 'android', 'X-Client-Version': '1.2.3' } });
    const res = await http.request({ url: `${ORIGIN}/a`, method: 'GET', headers: { Authorization: 'Bearer t' } });
    const sent = new Headers(fetch.mock.calls[0]?.[1].headers);
    expect(sent.get('x-client-platform')).toBe('android');
    expect(sent.get('x-client-version')).toBe('1.2.3');
    expect(sent.get('authorization')).toBe('Bearer t');
    expect(res.upgrade).toBe('required');
    expect(onUpgrade).toHaveBeenCalledWith('required', ORIGIN);
  });
});

describe('http wrapper: redaction (P0-9)', () => {
  it('redact removes bearer tokens and token-like parameters', () => {
    const text = 'Authorization: Bearer abc.def refresh_token=RT1&code=C1&code_verifier=V1&state=S1&access_token=AT1&client_secret=CS1';
    const out = redact(text);
    for (const secret of ['abc.def', 'RT1', 'C1', 'V1', 'S1', 'AT1', 'CS1']) expect(out).not.toContain(secret);
    expect(redact('plain text')).toBe('plain text');
  });

  it('safeUrlForLog keeps origin and path only', () => {
    expect(safeUrlForLog(`${ORIGIN}/oauth/callback?code=SECRET&state=S#frag`)).toBe(`${ORIGIN}/oauth/callback`);
    expect(safeUrlForLog('io.inspectorhub.app:/oauth/callback?code=SECRET')).not.toContain('SECRET');
  });

  it('logs method, path and status only', async () => {
    const lines: string[] = [];
    const http = createHttp({ fetch: () => Promise.resolve(ok()), log: (l) => lines.push(l) });
    await http.request({ url: `${ORIGIN}/oauth/token?code=SECRET`, method: 'POST', body: 'refresh_token=SECRET', headers: { Authorization: 'Bearer SECRET' } });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('SECRET');
    expect(lines.join('\n')).toContain('/oauth/token');
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds, caps it, and ignores dates and junk', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('999999')).toBe(3_600_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe('http wrapper: the server Date header', () => {
  const request = (headers: Record<string, string>) =>
    createHttp({ fetch: () => Promise.resolve(new Response('{}', { status: 200, headers })) }).request({ url: `${ORIGIN}/a`, method: 'GET' });

  it('exposes a valid Date header as epoch milliseconds', async () => {
    expect((await request({ date: 'Wed, 21 Oct 2026 07:28:00 GMT' })).serverDateMs).toBe(Date.UTC(2026, 9, 21, 7, 28, 0));
  });

  it.each([['no header', {}], ['an unparseable header', { date: 'yesterday-ish' }], ['an empty header', { date: '' }]])('is null for %s', async (_label, headers) => {
    expect((await request(headers)).serverDateMs).toBeNull();
  });
});

describe('parseServerDate accepts only the IMF-fixdate form, in GMT', () => {
  it('control: a well-formed date parses to its instant', () => {
    expect(parseServerDate('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(Date.UTC(2026, 9, 21, 7, 28, 0));
    expect(parseServerDate('Sat, 24 Oct 2026 12:00:00 GMT')).toBe(Date.UTC(2026, 9, 24, 12, 0, 0));
  });

  it.each([
    ['a local-time form without a zone', 'Wed, 21 Oct 2026 07:28:00'],
    ['a numeric offset instead of GMT', 'Wed, 21 Oct 2026 07:28:00 +0200'],
    ['a named non-GMT zone', 'Wed, 21 Oct 2026 07:28:00 PST'],
    ['the asctime form', 'Sat Oct 24 12:00:00 2026'],
    ['ISO 8601', '2026-10-24T12:00:00Z'],
    ['ISO 8601 without a zone', '2026-10-24T12:00:00'],
    ['a multi-value join', 'Wed, 21 Oct 2026 07:28:00 GMT, Wed, 21 Oct 2026 07:28:00 GMT'],
    ['a weekday that does not match the date', 'Mon, 21 Oct 2026 07:28:00 GMT'],
    ['an impossible calendar day', 'Sat, 31 Oct 2026 24:00:00 GMT'],
    ['a day that rolls over', 'Sat, 31 Nov 2026 12:00:00 GMT'],
    ['an obsolete two-digit year', 'Wed, 21 Oct 26 07:28:00 GMT'],
    ['surrounding junk', 'x Wed, 21 Oct 2026 07:28:00 GMT'],
  ])('rejects %s', (_label, value) => {
    expect(parseServerDate(value)).toBeNull();
  });
});
