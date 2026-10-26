import { describe, expect, it } from 'vitest';
import { AuthError } from '../auth/errors';
import type { Http, HttpResponse } from '../auth/http';
import type { SessionCheck } from '../auth/tokens';
import { observeServerContact, type ReachSink } from './server-reach';

function sink(): ReachSink & { events: string[] } {
  const events: string[] = [];
  return { events, reached: () => events.push('reached'), unreachable: () => events.push('unreachable'), paused: () => events.push('paused') };
}

const response = (status: number): HttpResponse => ({ status, headers: new Headers(), text: '', json: undefined, retryAfterMs: null, upgrade: null, serverDateMs: null });
const REQ = { url: 'https://oi.example.test/x', method: 'GET' } as const;
const OK = { kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 7 } } as unknown as SessionCheck;

interface Parts {
  http?: Http['request'];
  get?: () => Promise<string | null>;
  check?: () => Promise<SessionCheck>;
  sink?: ReachSink;
}

function watched(parts: Parts) {
  const s = parts.sink ?? sink();
  const out = observeServerContact({ request: parts.http ?? (() => Promise.resolve(response(200))) }, { getAccessToken: parts.get ?? (() => Promise.resolve('t')), checkSession: parts.check ?? (() => Promise.resolve(OK)) }, s);
  return { ...out, events: (s as ReturnType<typeof sink>).events };
}

describe('http: any answer means the server was reached', () => {
  it.each([200, 204, 301, 400, 401, 404, 409, 426, 429, 500, 503])('a %i is an answer', async (status) => {
    const w = watched({ http: () => Promise.resolve(response(status)) });
    expect((await w.http.request(REQ)).status).toBe(status);
    expect(w.events).toEqual(['reached']);
  });

  it.each(['server_unreachable', 'server_timeout'] as const)('a thrown %s marks unreachable and is rethrown as it was', async (code) => {
    const error = new AuthError(code);
    const w = watched({ http: () => Promise.reject(error) });
    await expect(w.http.request(REQ)).rejects.toBe(error);
    expect(w.events).toEqual(['unreachable']);
  });

  it.each(['server_redirected', 'server_response_invalid', 'storage_failed'] as const)('a thrown %s is not "no answer": it is rethrown and tells nothing', async (code) => {
    const error = new AuthError(code);
    const w = watched({ http: () => Promise.reject(error) });
    await expect(w.http.request(REQ)).rejects.toBe(error);
    expect(w.events).toEqual([]);
  });

  it('an error that is not an AuthError is rethrown and tells nothing', async () => {
    const error = new Error('boom');
    const w = watched({ http: () => Promise.reject(error) });
    await expect(w.http.request(REQ)).rejects.toBe(error);
    expect(w.events).toEqual([]);
  });
});

describe('getAccessToken: the cause the token manager carried decides, not the error code', () => {
  it.each([
    ['no_answer', 'unreachable'],
    ['answered', 'paused'],
    ['local', 'paused'],
  ] as const)('a %s failure tells %s', async (cause, event) => {
    const error = new AuthError('server_unreachable', cause);
    const w = watched({ get: () => Promise.reject(error) });
    await expect(w.tokens.getAccessToken('o')).rejects.toBe(error);
    expect(w.events).toEqual([event]);
  });

  it.each(['upgrade_required', 'none'] as const)('a %s failure tells nothing (the upgrade panel owns the first)', async (cause) => {
    const w = watched({ get: () => Promise.reject(new AuthError('server_response_invalid', cause)) });
    await expect(w.tokens.getAccessToken('o')).rejects.toBeDefined();
    expect(w.events).toEqual([]);
  });

  it('control: the same code with another cause tells the other thing (the code is not what decides)', async () => {
    const a = watched({ get: () => Promise.reject(new AuthError('server_unreachable', 'answered')) });
    await expect(a.tokens.getAccessToken('o')).rejects.toBeDefined();
    const b = watched({ get: () => Promise.reject(new AuthError('server_response_invalid', 'no_answer')) });
    await expect(b.tokens.getAccessToken('o')).rejects.toBeDefined();
    expect([a.events, b.events]).toEqual([['paused'], ['unreachable']]);
  });

  it('a token that is given is returned as it is and tells nothing (a cached token proves nothing about the server)', async () => {
    const w = watched({ get: () => Promise.resolve('abc') });
    expect(await w.tokens.getAccessToken('o')).toBe('abc');
    const none = watched({ get: () => Promise.resolve(null) });
    expect(await none.tokens.getAccessToken('o')).toBeNull();
    expect([w.events, none.events]).toEqual([[], []]);
  });
});

describe('checkSession', () => {
  it('ok and relogin mean the server answered; the result is returned as it is', async () => {
    const relogin: SessionCheck = { kind: 'relogin' };
    const a = watched({ check: () => Promise.resolve(OK) });
    const b = watched({ check: () => Promise.resolve(relogin) });
    expect(await a.tokens.checkSession('o')).toBe(OK);
    expect(await b.tokens.checkSession('o')).toBe(relogin);
    expect([a.events, b.events]).toEqual([['reached'], ['reached']]);
  });

  it.each([
    ['no_answer', 'unreachable'],
    ['answered', 'paused'],
    ['local', 'paused'],
  ] as const)('a retry with the cause %s tells %s', async (cause, event) => {
    const retry: SessionCheck = { kind: 'retry', reason: 'network', retryAfterMs: 1, cause };
    const w = watched({ check: () => Promise.resolve(retry) });
    expect(await w.tokens.checkSession('o')).toBe(retry);
    expect(w.events).toEqual([event]);
  });

  it.each(['upgrade_required', 'none'] as const)('a retry with the cause %s tells nothing', async (cause) => {
    const w = watched({ check: () => Promise.resolve({ kind: 'retry', reason: 'superseded', retryAfterMs: 0, cause }) });
    await w.tokens.checkSession('o');
    expect(w.events).toEqual([]);
  });

  it('signed_out tells nothing, and the options are passed on', async () => {
    let seen: unknown;
    const out = observeServerContact(
      { request: () => Promise.resolve(response(200)) },
      {
        getAccessToken: () => Promise.resolve('t'),
        checkSession: (_origin, options) => {
          seen = options;
          return Promise.resolve({ kind: 'signed_out' } as SessionCheck);
        },
      },
      sink(),
    );
    expect(await out.tokens.checkSession('o', { ignoreBackoff: true })).toEqual({ kind: 'signed_out' });
    expect(seen).toEqual({ ignoreBackoff: true });
    expect(watched({ check: () => Promise.resolve({ kind: 'signed_out' }) }).events).toEqual([]);
  });

  it('an exception passes through unchanged', async () => {
    const error = new Error('x');
    const w = watched({ check: () => Promise.reject(error) });
    await expect(w.tokens.checkSession('o')).rejects.toBe(error);
  });
});

describe('a sink that throws never changes what the real call did', () => {
  const boom = (): never => {
    throw new Error('sink');
  };
  const throwing: ReachSink = { reached: boom, unreachable: boom, paused: boom };

  it('a response is still returned', async () => {
    const w = watched({ sink: throwing });
    expect((await w.http.request(REQ)).status).toBe(200);
  });

  it('the original exception is still the one thrown', async () => {
    const error = new AuthError('server_unreachable');
    const w = watched({ sink: throwing, http: () => Promise.reject(error) });
    await expect(w.http.request(REQ)).rejects.toBe(error);
  });

  it('a token error and a session verdict are still passed on', async () => {
    const error = new AuthError('server_unreachable', 'no_answer');
    const a = watched({ sink: throwing, get: () => Promise.reject(error) });
    await expect(a.tokens.getAccessToken('o')).rejects.toBe(error);
    const retry: SessionCheck = { kind: 'retry', reason: 'network', retryAfterMs: 1, cause: 'no_answer' };
    const b = watched({ sink: throwing, check: () => Promise.resolve(retry) });
    expect(await b.tokens.checkSession('o')).toBe(retry);
  });
});
