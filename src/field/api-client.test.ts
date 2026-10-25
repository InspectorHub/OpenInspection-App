import { afterEach, describe, expect, it } from 'vitest';
import { AuthError } from '../auth/errors';
import { createHttp, type Http, type HttpRequest, type HttpResponse } from '../auth/http';
import type { TokenManager } from '../auth/tokens';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { apiPath, createApiClient, type ApiClientDeps } from './api-client';

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
    expect(apiPath('insp-1', 'units', 'a/b c')).toBe('/api/inspections/insp-1/units/a%2Fb%20c');
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

  it('a timeout and an unreachable server are told apart', async () => {
    const slow = rig([new AuthError('server_timeout')]);
    expect(await createApiClient(slow.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'timeout' });
    const down = rig([new AuthError('server_unreachable')]);
    expect(await createApiClient(down.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'offline' });
    const odd = rig([new Error('anything')]);
    expect(await createApiClient(odd.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'offline' });
  });

  it('a closed gate sends nothing; an open gate sends', async () => {
    const closed = rig([response(200)], { gate: () => false });
    expect(await createApiClient(closed.deps).send({ method: 'GET', path: '/api/x' })).toEqual({ kind: 'problem', problem: 'auth' });
    expect(closed.requests).toHaveLength(0);
    const open = rig([response(200)], { gate: () => true });
    expect(await createApiClient(open.deps).send({ method: 'GET', path: '/api/x' })).toMatchObject({ kind: 'response' });
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
