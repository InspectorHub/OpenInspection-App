import { afterEach, describe, expect, it } from 'vitest';
import { AuthError } from '../auth/errors';
import { createHttp, type Http, type HttpRequest, type HttpResponse } from '../auth/http';
import type { TokenManager } from '../auth/tokens';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { apiPath, apiRoute, createApiClient, templatePath, type ApiClientDeps } from './api-client';

const ORIGIN = 'https://app.example.com';

function response(status: number, json?: unknown): HttpResponse {
  return { status, headers: new Headers(), text: json === undefined ? '' : JSON.stringify(json), json, retryAfterMs: null, upgrade: null, serverDateMs: null };
}

interface Rig {
  deps: ApiClientDeps;
  requests: HttpRequest[];
  tokenReads: () => number;
}

function rig(answers: (HttpResponse | Error)[], options: { tokens?: (string | null)[]; session?: Awaited<ReturnType<TokenManager['checkSession']>>; gate?: () => boolean } = {}): Rig {
  const requests: HttpRequest[] = [];
  const queue = [...answers];
  const tokens = [...(options.tokens ?? ['tok-1'])];
  let reads = 0;
  const http: Http = {
    request: (req) => {
      requests.push(req);
      const next = queue.shift();
      if (next === undefined) return Promise.reject(new Error('no answer queued'));
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
  const deps: ApiClientDeps = {
    http,
    origin: ORIGIN,
    clientHeaders: { 'X-Client-Platform': 'android', Authorization: 'Bearer evil', 'idempotency-key': 'evil' },
    tokens: {
      getAccessToken: () => {
        reads += 1;
        return Promise.resolve(tokens.length > 1 ? (tokens.shift() ?? null) : (tokens[0] ?? null));
      },
      checkSession: () => Promise.resolve(options.session ?? { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 14 } }),
    },
    ...(options.gate ? { gate: options.gate } : {}),
  };
  return { deps, requests, tokenReads: () => reads };
}

afterEach(() => {
  restoreGlobals();
});

describe('api path', () => {
  it('builds an inspection path from a checked id and encoded segments', () => {
    expect(apiPath('insp-1')).toBe('/api/inspections/insp-1');
    expect(apiPath('insp-1', 'units', 'a b')).toBe('/api/inspections/insp-1/units/a%20b');
    expect(apiPath('insp-1', 'units', 'u.1', '..x', 'x..')).toBe('/api/inspections/insp-1/units/u.1/..x/x..');
  });

  it('refuses a segment the URL parser would resolve away: dot segments, empty ones, slashes, and encoded dots', () => {
    for (const bad of ['..', '.', '', '%2e%2e', '%2E', '.%2e', 'units/../duplicate', 'a/b', String.raw`a\b`, '%2e%2e%2f', '%252e%252e']) {
      expect(() => apiPath('insp-1', bad), JSON.stringify(bad)).toThrow(RangeError);
    }
    expect(() => apiPath('insp-1', 'units', '..', 'duplicate')).toThrow(RangeError);
  });

  it('templatePath checks its id the same way', () => {
    expect(templatePath()).toBe('/api/inspections/templates');
    expect(templatePath('tpl-1')).toBe('/api/inspections/templates/tpl-1');
    for (const bad of ['..', '', '%2e%2e', 'a/b']) expect(() => templatePath(bad)).toThrow(RangeError);
  });

  it('apiRoute joins checked, encoded segments to a fixed route', () => {
    expect(apiRoute('/api/admin/comments')).toBe('/api/admin/comments');
    expect(apiRoute('/api/admin/comments', 'c 1', 'touch')).toBe('/api/admin/comments/c%201/touch');
    for (const bad of ['..', '', '%2e%2e', 'a/b']) expect(() => apiRoute('/api/admin/comments', bad), bad).toThrow(RangeError);
    for (const base of ['/other', '/api/x?y=1', '/api/../admin', 'https://evil.example/api/x']) expect(() => apiRoute(base), base).toThrow(RangeError);
  });

  it('refuses an id that is not an inspection id', () => {
    expect(() => apiPath('../x')).toThrow(RangeError);
    expect(() => apiPath('bulk')).toThrow(RangeError);
    expect(() => apiPath('')).toThrow(RangeError);
  });
});

describe('api client', () => {
  it('sends a Bearer request to the pinned origin with client headers only, and parses the answer', async () => {
    const r = rig([response(200, { ok: 1 })]);
    const outcome = await createApiClient(r.deps).send({ method: 'POST', path: '/api/inspections/i1/complete', json: { a: 1 } });
    expect(outcome).toEqual({ kind: 'response', status: 200, json: { ok: 1 } });
    const req = r.requests[0];
    expect(req?.url).toBe(`${ORIGIN}/api/inspections/i1/complete`);
    expect(req?.method).toBe('POST');
    expect(req?.body).toBe('{"a":1}');
    expect(req?.headers).toMatchObject({ Authorization: 'Bearer tok-1', 'content-type': 'application/json', 'X-Client-Platform': 'android' });
    expect(req?.headers?.Authorization).not.toContain('evil');
    expect(Object.keys(req?.headers ?? {}).map((k) => k.toLowerCase()).filter((k) => k === 'authorization')).toHaveLength(1);
    expect(req?.headers).not.toHaveProperty('idempotency-key');
  });

  it('control: the idempotency key is sent only when the call has one', async () => {
    const r = rig([response(200), response(200)]);
    const api = createApiClient(r.deps);
    await api.send({ method: 'POST', path: '/api/inspections/i1/units', json: {}, idempotencyKey: 'key-1' });
    await api.send({ method: 'POST', path: '/api/inspections/i1/units', json: {} });
    expect(r.requests[0]?.headers).toMatchObject({ 'Idempotency-Key': 'key-1' });
    expect(r.requests[1]?.headers).not.toHaveProperty('Idempotency-Key');
  });

  it('appends query parameters encoded after the path, and only when there are some', async () => {
    const r = rig([response(200), response(200), response(200)]);
    const api = createApiClient(r.deps);
    await api.send({ method: 'GET', path: '/api/inspections/templates', query: { page: '1', q: 'a b&c=d' } });
    await api.send({ method: 'GET', path: '/api/inspections/templates', query: {} });
    await api.send({ method: 'GET', path: '/api/inspections/templates' });
    expect(r.requests[0]?.url).toBe(`${ORIGIN}/api/inspections/templates?page=1&q=a+b%26c%3Dd`);
    expect(r.requests[1]?.url).toBe(`${ORIGIN}/api/inspections/templates`);
    expect(r.requests[2]?.url).toBe(`${ORIGIN}/api/inspections/templates`);
  });

  it('a query in the path itself is still refused, whatever query parameters are given', async () => {
    const r = rig([response(200)]);
    await expect(createApiClient(r.deps).send({ method: 'GET', path: '/api/x?y=1', query: { a: 'b' } })).rejects.toThrow(RangeError);
    expect(r.requests).toHaveLength(0);
  });

  it('sends a form without setting its content type', async () => {
    const r = rig([response(200)]);
    const form = new FormData();
    form.append('image', new Blob(['x']), 'a.png');
    await createApiClient(r.deps).send({ method: 'POST', path: '/api/inspections/i1/cover', form });
    expect(r.requests[0]?.form).toBe(form);
    expect(r.requests[0]?.body).toBeUndefined();
    expect(Object.keys(r.requests[0]?.headers ?? {}).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('refuses a path that is not under /api/ before any token is read', async () => {
    const r = rig([response(200)]);
    await expect(createApiClient(r.deps).send({ method: 'GET', path: 'https://evil.example/api/x' })).rejects.toThrow(RangeError);
    await expect(createApiClient(r.deps).send({ method: 'GET', path: '/other' })).rejects.toThrow(RangeError);
    for (const path of ['/api/inspections/../admin', '/api/inspections/%2e%2e/admin', '/api/inspections//x', '/api/x?y=1', '/api/x#y']) {
      await expect(createApiClient(r.deps).send({ method: 'GET', path }), path).rejects.toThrow(RangeError);
    }
    expect(r.requests).toHaveLength(0);
    expect(r.tokenReads()).toBe(0);
  });

  it('an HTTP error status is a response, not a problem', async () => {
    const r = rig([response(422, { error: { message: 'bad' } })]);
    expect(await createApiClient(r.deps).send({ method: 'PATCH', path: '/api/inspections/i1', json: {} })).toEqual({ kind: 'response', status: 422, json: { error: { message: 'bad' } } });
  });

  it('a 401 is checked with the token manager and asked again once with a fresh token', async () => {
    const r = rig([response(401), response(200, { ok: 1 })], { tokens: ['old', 'new'] });
    const outcome = await createApiClient(r.deps).send({ method: 'GET', path: '/api/inspections/i1' });
    expect(outcome).toMatchObject({ kind: 'response', status: 200 });
    expect(r.requests.map((q) => q.headers?.Authorization)).toEqual(['Bearer old', 'Bearer new']);
  });

  it('a second 401, a signed-out session and a missing token are all an auth problem', async () => {
    const twice = rig([response(401), response(401)]);
    expect(await createApiClient(twice.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'auth' });
    const relogin = rig([response(401)], { session: { kind: 'relogin' } });
    expect(await createApiClient(relogin.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'auth' });
    const none = rig([response(200)], { tokens: [null] });
    expect(await createApiClient(none.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'auth' });
    expect(none.requests).toHaveLength(0);
  });

  it('426 is an upgrade problem', async () => {
    const r = rig([response(426)]);
    expect(await createApiClient(r.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'upgrade' });
  });

  it('a transport failure of a write after it was sent is an unknown outcome, whatever the failure was', async () => {
    for (const failure of [new AuthError('server_timeout'), new AuthError('server_unreachable'), new AuthError('server_redirected'), new AuthError('server_response_invalid'), new Error('anything')]) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE'] as const) {
        const r = rig([failure]);
        expect(await createApiClient(r.deps).send({ method, path: '/api/x', json: {} })).toEqual({ kind: 'problem', problem: 'unknown' });
        expect(r.requests).toHaveLength(1);
      }
    }
  });

  it('control: the same failure of a read is simply offline, and nothing was at stake', async () => {
    for (const failure of [new AuthError('server_timeout'), new AuthError('server_unreachable'), new Error('anything')]) {
      const r = rig([failure]);
      expect(await createApiClient(r.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'offline' });
    }
  });

  it('a closed gate sends nothing and says the device is locked; an open gate sends', async () => {
    const closed = rig([response(200)], { gate: () => false });
    expect(await createApiClient(closed.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'locked' });
    expect(closed.requests).toHaveLength(0);
    const open = rig([response(200)], { gate: () => true });
    expect(await createApiClient(open.deps).send({ method: 'GET', path: '/api/x' })).toMatchObject({ kind: 'response' });
  });

  it('a gate that throws fails closed: nothing is sent', async () => {
    const throws = rig([response(200)], {
      gate: () => {
        throw new Error('lock state unreadable');
      },
    });
    expect(await createApiClient(throws.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'locked' });
    expect(throws.requests).toHaveLength(0);
  });

  it('a gate that closes between the first attempt and the retry stops the retry', async () => {
    let calls = 0;
    const r = rig([response(401), response(200)], { gate: () => (calls += 1) < 2 });
    expect(await createApiClient(r.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'locked' });
    expect(r.requests).toHaveLength(1);
  });

  it('bounds the answer it will read, and the time it waits (longer for an upload)', async () => {
    const r = rig([response(200), response(200)]);
    const api = createApiClient(r.deps);
    await api.send({ method: 'GET', path: '/api/x' });
    const form = new FormData();
    form.append('a', 'b');
    await api.send({ method: 'POST', path: '/api/x', form });
    expect(r.requests[0]?.maxBytes).toBe(1_048_576);
    expect(r.requests[0]?.timeoutMs).toBe(20_000);
    expect(r.requests[1]?.timeoutMs).toBe(90_000);
    await api.send({ method: 'GET', path: '/api/x', timeoutMs: 5 });
  });

  it('a session check that says retry, or throws, or a token read that throws, are all offline (the request was not applied)', async () => {
    const retry = rig([response(401)], { session: { kind: 'retry', reason: 'network', retryAfterMs: 1, cause: 'no_answer' } });
    expect(await createApiClient(retry.deps).send({ method: 'POST', path: '/api/x', json: {} })).toEqual({ kind: 'problem', problem: 'offline' });
    const throwingSession = rig([response(401)]);
    throwingSession.deps.tokens.checkSession = () => Promise.reject(new Error('x'));
    expect(await createApiClient(throwingSession.deps).send({ method: 'POST', path: '/api/x', json: {} })).toEqual({ kind: 'problem', problem: 'offline' });
    const throwingToken = rig([response(200)]);
    throwingToken.deps.tokens.getAccessToken = () => Promise.reject(new Error('store down'));
    expect(await createApiClient(throwingToken.deps).send({ method: 'POST', path: '/api/x', json: {} })).toEqual({ kind: 'problem', problem: 'offline' });
    expect(throwingToken.requests).toHaveLength(0);
  });

  it('works through the real http wrapper with the strict browser globals, a form body included', async () => {
    installStrictGlobals();
    const seen: { url: string; init: RequestInit }[] = [];
    const http = createHttp({
      fetch: (input, init) => {
        seen.push({ url: input, init });
        return fetch('data:application/json,%7B%22ok%22%3A1%7D').then((res) => new Response(res.body, { status: 200, headers: { 'content-type': 'application/json' } }));
      },
    });
    const r = rig([]);
    const form = new FormData();
    form.append('file', new Blob(['x']), 'a.jpg');
    const outcome = await createApiClient({ ...r.deps, http }).send({ method: 'POST', path: '/api/inspections/i1/media/upload', form });
    expect(outcome).toEqual({ kind: 'response', status: 200, json: { ok: 1 } });
    expect(seen[0]?.init.credentials).toBe('omit');
    expect(seen[0]?.init.body).toBe(form);
  });
});

describe('a server too old for this app (serverTooOld)', () => {
  const tooOld = (value: boolean | Promise<boolean> | Error): ApiClientDeps['serverTooOld'] =>
    value instanceof Error
      ? () => {
          throw value;
        }
      : () => value;

  it('sends nothing and answers its own problem, not locked (control: not too old sends)', async () => {
    const old = rig([response(200)]);
    expect(await createApiClient({ ...old.deps, serverTooOld: tooOld(true) }).send({ method: 'POST', path: '/api/x', json: {} })).toEqual({ kind: 'problem', problem: 'server_too_old' });
    expect(old.requests).toHaveLength(0);
    expect(old.tokenReads()).toBe(0);
    const fine = rig([response(200)]);
    expect(await createApiClient({ ...fine.deps, serverTooOld: tooOld(false) }).send({ method: 'POST', path: '/api/x', json: {} })).toMatchObject({ kind: 'response' });
    expect(fine.requests).toHaveLength(1);
  });

  it('may answer later (a promise), and the lock keeps its own problem when both hold', async () => {
    const late = rig([response(200)]);
    expect(await createApiClient({ ...late.deps, serverTooOld: tooOld(Promise.resolve(true)) }).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'server_too_old' });
    const both = rig([response(200)], { gate: () => false });
    expect(await createApiClient({ ...both.deps, serverTooOld: tooOld(true) }).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'locked' });
  });

  it('a check that throws counts as not known, so as not too old: the request goes ahead', async () => {
    const r = rig([response(200)]);
    expect(await createApiClient({ ...r.deps, serverTooOld: tooOld(new Error('state unreadable')) }).send({ method: 'GET', path: '/api/x' })).toMatchObject({ kind: 'response' });
  });

  it('is asked again before the retry after a 401', async () => {
    let calls = 0;
    const r = rig([response(401), response(200)]);
    const answer = await createApiClient({ ...r.deps, serverTooOld: () => (calls += 1) >= 2 }).send({ method: 'GET', path: '/api/x' });
    expect(answer).toEqual({ kind: 'problem', problem: 'server_too_old' });
    expect(r.requests).toHaveLength(1);
  });
});
