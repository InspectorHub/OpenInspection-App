import { describe, expect, it } from 'vitest';
import type { Http, HttpRequest, HttpResponse } from '../auth/http';
import { createApiClient } from './api-client';

const ORIGIN = 'https://app.example.com';
const PATH = '/api/client/import';
const ZIP = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x80, 0xff, 0x00, 0x7f]);

function answer(status: number, text: string): HttpResponse {
  let json: unknown;
  try {
    json = text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    json = undefined;
  }
  return { status, headers: new Headers(), text, json, retryAfterMs: null, upgrade: null, serverDateMs: null };
}

function rig(reply: HttpResponse) {
  const requests: HttpRequest[] = [];
  const http: Http = {
    request: (req) => {
      requests.push(req);
      return Promise.resolve(reply);
    },
  };
  const api = createApiClient({
    http,
    origin: ORIGIN,
    tokens: { getAccessToken: () => Promise.resolve('tok-1'), checkSession: () => Promise.resolve({ kind: 'retry', reason: 'network', retryAfterMs: 1, cause: 'no_answer' }) },
  });
  return { api, requests };
}

describe('api client: byte bodies', () => {
  it('sends the bytes with the caller content type, a Bearer token and no JSON content type', async () => {
    const { api, requests } = rig(answer(200, '{"ok":true}'));
    await api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip' });
    const sent = requests[0];
    expect(sent?.bodyBytes).toBe(ZIP);
    expect(sent?.body).toBeUndefined();
    expect(sent?.form).toBeUndefined();
    expect(sent?.headers?.['content-type']).toBe('application/zip');
    expect(sent?.headers?.Authorization).toBe('Bearer tok-1');
    expect(sent?.url).toBe(`${ORIGIN}${PATH}`);
  });

  it('control: a JSON call still sends its text body with the JSON content type', async () => {
    const { api, requests } = rig(answer(200, '{}'));
    await api.send({ method: 'POST', path: PATH, json: { a: 1 } });
    expect(requests[0]?.body).toBe('{"a":1}');
    expect(requests[0]?.bodyBytes).toBeUndefined();
    expect(requests[0]?.headers?.['content-type']).toBe('application/json');
  });

  it('refuses a call that carries bytes and also json or a form, and a byte body without a content type', async () => {
    const { api, requests } = rig(answer(200, '{}'));
    await expect(api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip', json: {} })).rejects.toBeInstanceOf(RangeError);
    await expect(api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip', form: new FormData() })).rejects.toBeInstanceOf(RangeError);
    await expect(api.send({ method: 'POST', path: PATH, bytes: ZIP })).rejects.toBeInstanceOf(RangeError);
    await expect(api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip\r\nX-Evil: 1' })).rejects.toBeInstanceOf(RangeError);
    expect(requests).toHaveLength(0);
  });

  it('a byte upload gets the long upload timeout by default, and an explicit one wins', async () => {
    const first = rig(answer(200, '{}'));
    await first.api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip' });
    expect(first.requests[0]?.timeoutMs).toBe(90_000);
    const second = rig(answer(200, '{}'));
    await second.api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip', timeoutMs: 123_000 });
    expect(second.requests[0]?.timeoutMs).toBe(123_000);
  });
});

describe('api client: the text of an answer that is not JSON', () => {
  it('is handed back only when the call asks for it', async () => {
    const page = '<html>gateway</html>';
    const asked = await rig(answer(502, page)).api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip', keepText: true });
    expect(asked).toMatchObject({ kind: 'response', status: 502, text: page });
    const notAsked = await rig(answer(502, page)).api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip' });
    expect(notAsked).toEqual({ kind: 'response', status: 502, json: undefined });
  });

  it('is not added to an answer that parsed as JSON (positive control)', async () => {
    const asked = await rig(answer(404, '{"error":{"code":"NOT_FOUND"}}')).api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip', keepText: true });
    expect(asked).toEqual({ kind: 'response', status: 404, json: { error: { code: 'NOT_FOUND' } } });
  });
});

describe('api client: a byte body after a 401', () => {
  function refreshRig(answers: HttpResponse[]) {
    const requests: HttpRequest[] = [];
    const queue = [...answers];
    const tokens = ['tok-old', 'tok-new'];
    const http: Http = {
      request: (req) => {
        requests.push(req);
        return Promise.resolve(queue.shift() ?? answer(500, ''));
      },
    };
    const api = createApiClient({
      http,
      origin: ORIGIN,
      tokens: {
        getAccessToken: () => Promise.resolve(tokens.length > 1 ? (tokens.shift() ?? null) : (tokens[0] ?? null)),
        checkSession: () => Promise.resolve({ kind: 'ok', session: { userId: 'u', tenantId: 't', role: 'inspector', offlineMaxDays: 14 } }),
      },
    });
    return { api, requests };
  }

  it('is sent again once, unchanged, with the refreshed token', async () => {
    const { api, requests } = refreshRig([answer(401, ''), answer(200, '{"ok":true}')]);
    const outcome = await api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip' });
    expect(outcome).toMatchObject({ kind: 'response', status: 200 });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.bodyBytes).toBe(ZIP);
    expect(requests[1]?.bodyBytes).toBe(ZIP);
    expect(requests[0]?.headers?.Authorization).toBe('Bearer tok-old');
    expect(requests[1]?.headers?.Authorization).toBe('Bearer tok-new');
    expect(requests[1]?.headers?.['content-type']).toBe('application/zip');
  });

  it('control: a second 401 is not tried a third time', async () => {
    const { api, requests } = refreshRig([answer(401, ''), answer(401, ''), answer(200, '{}')]);
    const outcome = await api.send({ method: 'POST', path: PATH, bytes: ZIP, contentType: 'application/zip' });
    expect(outcome).toEqual({ kind: 'problem', problem: 'auth' });
    expect(requests).toHaveLength(2);
  });
});
