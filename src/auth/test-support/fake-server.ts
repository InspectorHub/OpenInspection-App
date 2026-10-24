import type { AuthSession } from '../auth-session';
import { AuthError } from '../errors';
import type { FetchLike } from '../http';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  form: Record<string, string>;
  json: unknown;
}

export interface FakeServerOptions {
  origin?: string;
  nativeEnabled?: boolean;
  /** Answer registration with a `client_secret` the client must ignore. */
  issueClientSecret?: boolean;
  /** Add an `iss` parameter to the authorization callback. */
  issuerInCallback?: boolean;
  contractVersion?: number;
  accessTtlSec?: number;
  role?: string;
  userId?: string;
  tenantId?: string;
}

type Handler = () => Response | Promise<Response>;

interface Grant {
  id: string;
  clientId: string;
  current: string;
  previous: string | null;
  revoked: boolean;
}

interface CodeRecord {
  clientId: string;
  redirectUri: string;
  challenge: string;
  grantId: string | null;
  used: boolean;
}

export type AuthorizeMode = 'approve' | 'deny' | 'dismiss';

export interface FakeServer {
  origin: string;
  fetch: FetchLike;
  requests: RecordedRequest[];
  authSession: AuthSession;
  authorizeMode: AuthorizeMode;
  nativeEnabled: boolean;
  /** Next response for `path` (consumed once, in order). */
  queue(path: string, handler: Handler): void;
  /** Next request to `path` never answers (until its signal aborts). */
  hang(path: string): void;
  /** Revokes every grant, as removing the member would. */
  revokeAllGrants(): void;
  /** Every credential the server ever issued: tokens, codes, client secrets. */
  secrets(): string[];
  /** Follows an authorize URL like the browser would, returning the callback URL. */
  authorize(url: string): Promise<string>;
  grantCount(): number;
  /** Count of requests to `path` (any method). */
  count(path: string): number;
}

export const CALLBACK = 'io.inspectorhub.app:/oauth/callback';

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function oauthError(error: string, status = 400): Response {
  return json(status, { error, error_description: 'SERVER-TEXT-MUST-NOT-BE-SHOWN' });
}

/**
 * A hand-written fake of the engine's authorization server: register,
 * authorize (with PKCE S256 verification at the token step), token with
 * rotation and exactly one previous refresh token still accepted, revoke,
 * compat and session.
 */
export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  const origin = options.origin ?? 'https://oi.example.test';
  const accessTtl = options.accessTtlSec ?? 3600;
  const clients = new Map<string, { redirectUris: string[] }>();
  const codes = new Map<string, CodeRecord>();
  const grants = new Map<string, Grant>();
  const accessTokens = new Map<string, string>();
  const issued: string[] = [];
  const queues = new Map<string, Handler[]>();
  const hangs = new Map<string, number>();
  let seq = 0;

  const next = (prefix: string): string => {
    seq += 1;
    const token = `${prefix}-${String(seq)}-${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
    issued.push(token);
    return token;
  };

  async function authorize(rawUrl: string): Promise<string> {
    const p = new URL(rawUrl).searchParams;
    const state = p.get('state') ?? '';
    if (!server.nativeEnabled) throw new Error('authorize: 404 (native disabled)');
    const clientId = p.get('client_id') ?? '';
    const client = clients.get(clientId);
    if (!client) throw new Error('authorize: unknown client');
    if (p.get('redirect_uri') !== CALLBACK || !client.redirectUris.includes(CALLBACK)) throw new Error('authorize: redirect_uri mismatch');
    if (p.get('scope') !== 'native') throw new Error('authorize: scope must be exactly native');
    if (p.get('response_type') !== 'code') throw new Error('authorize: response_type');
    if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) throw new Error('authorize: PKCE S256 required');
    if (server.authorizeMode === 'deny') return `${CALLBACK}?error=access_denied&state=${encodeURIComponent(state)}`;
    const code = next('code');
    codes.set(code, { clientId, redirectUri: CALLBACK, challenge: p.get('code_challenge') ?? '', grantId: null, used: false });
    const iss = options.issuerInCallback ? `&iss=${encodeURIComponent(origin)}` : '';
    return `${CALLBACK}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}${iss}`;
  }

  function mint(grant: Grant): Response {
    const access = next('at');
    accessTokens.set(access, grant.id);
    return json(200, { access_token: access, token_type: 'bearer', expires_in: accessTtl, scope: 'native', refresh_token: grant.current });
  }

  async function token(form: Record<string, string>): Promise<Response> {
    const clientId = form.client_id ?? '';
    if (!clients.has(clientId)) return oauthError('invalid_client', 401);
    if (!form.grant_type) {
      const t = form.token ?? '';
      for (const g of grants.values()) {
        if (g.current === t || g.previous === t) g.revoked = true;
      }
      return new Response('', { status: 200 });
    }
    if (form.grant_type === 'authorization_code') {
      const rec = codes.get(form.code ?? '');
      if (!rec || rec.clientId !== clientId || rec.redirectUri !== form.redirect_uri) return oauthError('invalid_grant');
      if (rec.used) {
        const replayed = rec.grantId ? grants.get(rec.grantId) : undefined;
        if (replayed) replayed.revoked = true;
        return oauthError('invalid_grant');
      }
      if ((await s256(form.code_verifier ?? '')) !== rec.challenge) return oauthError('invalid_grant');
      rec.used = true;
      const id = `grant-${String(grants.size + 1)}`;
      const grant: Grant = { id, clientId, current: next('rt'), previous: null, revoked: false };
      grants.set(id, grant);
      rec.grantId = id;
      return mint(grant);
    }
    if (form.grant_type === 'refresh_token') {
      const t = form.refresh_token ?? '';
      const grant = [...grants.values()].find((g) => !g.revoked && g.clientId === clientId && (g.current === t || g.previous === t));
      if (!grant) return oauthError('invalid_grant');
      grant.previous = grant.current;
      grant.current = next('rt');
      return mint(grant);
    }
    return oauthError('unsupported_grant_type');
  }

  function route(url: URL, method: string, headers: Record<string, string>, form: Record<string, string>, body: unknown): Response | Promise<Response> {
    switch (url.pathname) {
      case '/api/client/compat':
        return json(200, { success: true, data: { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: options.contractVersion ?? 1 } });
      case '/api/client/session': {
        const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1] ?? '';
        const grantId = accessTokens.get(bearer);
        const grant = grantId ? grants.get(grantId) : undefined;
        if (!grant || grant.revoked) return json(401, { success: false });
        return json(200, {
          success: true,
          data: { userId: options.userId ?? 'user-1', tenantId: options.tenantId ?? 'tenant-1', role: options.role ?? 'inspector', offlineMaxDays: 30 },
        });
      }
      case '/oauth/register': {
        if (!server.nativeEnabled) return json(404, { error: 'not_found' });
        const req = body as { redirect_uris?: string[] } | undefined;
        if (method !== 'POST' || !req?.redirect_uris) return oauthError('invalid_client_metadata');
        const clientId = next('client');
        clients.set(clientId, { redirectUris: req.redirect_uris });
        const out: Record<string, unknown> = { client_id: clientId, redirect_uris: req.redirect_uris, token_endpoint_auth_method: 'none', client_id_issued_at: 1 };
        if (options.issueClientSecret) out.client_secret = next('secret');
        return json(201, out);
      }
      case '/oauth/token':
        return token(form);
      default:
        return new Response('not found', { status: 404 });
    }
  }

  const server: FakeServer = {
    origin,
    requests: [],
    authorizeMode: 'approve',
    nativeEnabled: options.nativeEnabled ?? true,
    fetch: async (input, init) => {
      const url = new URL(input);
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const form: Record<string, string> = {};
      let parsedJson: unknown;
      const body = typeof init.body === 'string' ? init.body : '';
      if ((headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
        new URLSearchParams(body).forEach((v, k) => {
          form[k] = v;
        });
      } else if (body) {
        parsedJson = JSON.parse(body);
      }
      server.requests.push({ method: init.method ?? 'GET', path: url.pathname, query: url.searchParams, headers, form, json: parsedJson });

      const hangsLeft = hangs.get(url.pathname) ?? 0;
      if (hangsLeft > 0) {
        hangs.set(url.pathname, hangsLeft - 1);
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      const scripted = queues.get(url.pathname)?.shift();
      if (scripted) return scripted();
      if (url.origin !== origin) return new Response('wrong host', { status: 404 });
      return route(url, init.method ?? 'GET', headers, form, parsedJson);
    },
    queue: (path, handler) => {
      queues.set(path, [...(queues.get(path) ?? []), handler]);
    },
    hang: (path) => {
      hangs.set(path, (hangs.get(path) ?? 0) + 1);
    },
    revokeAllGrants: () => {
      for (const g of grants.values()) g.revoked = true;
    },
    secrets: () => [...issued, ...codes.keys()],
    grantCount: () => grants.size,
    count: (path) => server.requests.filter((r) => r.path === path).length,
    authorize,
    authSession: {
      start: async (url) => {
        if (server.authorizeMode === 'dismiss') throw new AuthError('sign_in_cancelled');
        return authorize(url);
      },
      cancel: () => undefined,
      onBrowserClosed: () => () => undefined,
    },
  };

  return server;
}
