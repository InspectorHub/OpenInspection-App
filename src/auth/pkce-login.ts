import { calculatePKCECodeChallenge, generateRandomCodeVerifier, generateRandomState } from 'oauth4webapi';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { CALLBACK_SCHEME, parseCallbackUrl, REDIRECT_URI, type AuthSession } from './auth-session';
import { AuthError, isAuthError } from './errors';
import type { Http } from './http';
import type { Registrar } from './registration';
import { fetchSession, loadIdentity, saveIdentity, serverEndpoints, type SessionInfo } from './server-config';
import { NATIVE_SCOPE, oauthErrorCode, parseTokenResponse, type TokenManager, type TokenResponse } from './tokens';

export const PENDING_LOGIN_TTL_MS = 10 * 60_000;
const MAX_CODE_LENGTH = 2048;
const ALLOWED_ROLES = ['owner', 'manager', 'inspector'];

export interface LoginDeps {
  http: Http;
  db: Db;
  registrar: Registrar;
  tokens: TokenManager;
  authSession: AuthSession;
  clock: Clock;
  ttlMs?: number;
}

export interface SignInResult {
  origin: string;
  session: SessionInfo;
}

export interface LoginFlow {
  /** Runs one sign-in; a second call while one is running returns the same promise. */
  signIn(origin: string): Promise<SignInResult>;
  /**
   * Feeds a callback URL that arrived outside `signIn`. Returns null, with no
   * network call and no state change, when the URL is not the callback or no
   * login is waiting for it.
   */
  handleCallback(url: string): Promise<SignInResult | null>;
  hasPending(): boolean;
}

export function buildAuthorizeUrl(args: { origin: string; clientId: string; challenge: string; state: string }): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: args.clientId,
    redirect_uri: REDIRECT_URI,
    scope: NATIVE_SCOPE,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
    state: args.state,
  });
  return `${serverEndpoints(args.origin).authorize}?${params.toString()}`;
}

/** The query of an exact callback URL, or null when the URL is anything else. */
export function parseCallback(url: string): URLSearchParams | null {
  return parseCallbackUrl(url, CALLBACK_SCHEME);
}

/** The server refused our client id, so the stored registration is stale. */
class ClientRejected extends Error {}

interface Pending {
  state: string;
  verifier: string;
  origin: string;
  clientId: string;
  createdAt: number;
}

function single(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length === 1 ? (all[0] ?? null) : null;
}

export function createLoginFlow(deps: LoginDeps): LoginFlow {
  const ttl = deps.ttlMs ?? PENDING_LOGIN_TTL_MS;
  let pending: Pending | null = null;
  let running: Promise<SignInResult> | null = null;

  /** Consumes the pending login: it can be taken once, and never after its TTL. */
  function take(): Pending | null {
    const p = pending;
    pending = null;
    return p && deps.clock.now() - p.createdAt <= ttl ? p : null;
  }

  async function exchange(p: Pending, code: string): Promise<SignInResult> {
    const res = await deps.http.request({
      url: serverEndpoints(p.origin).token,
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: p.clientId,
        code_verifier: p.verifier,
      }).toString(),
    });
    if (res.status !== 200) {
      if (oauthErrorCode(res.text) === 'invalid_client') throw new ClientRejected();
      throw new AuthError('sign_in_failed');
    }
    const parsed = parseTokenResponse(res.json, true);
    if (!parsed.ok) {
      if (parsed.reason === 'scope') {
        await deps.tokens.revokeRefreshToken(p.origin, parsed.refreshToken);
        throw new AuthError('scope_mismatch');
      }
      throw new AuthError('server_response_invalid');
    }
    return finishLogin(p.origin, parsed.tokens);
  }

  /** Checks who signed in before anything is stored; on any refusal the new grant is revoked. */
  async function finishLogin(origin: string, tokens: TokenResponse): Promise<SignInResult> {
    try {
      const result = await fetchSession(deps.http, origin, tokens.accessToken);
      if (result.kind === 'unauthorized') throw new AuthError('sign_in_failed');
      const { session } = result;
      if (!ALLOWED_ROLES.includes(session.role)) throw new AuthError('session_role_not_allowed');
      const stored = await loadIdentity(deps.db);
      if (stored && (stored.userId !== session.userId || stored.tenantId !== session.tenantId)) throw new AuthError('identity_mismatch');
      await deps.tokens.adopt(origin, tokens);
      try {
        if (!stored || stored.role !== session.role) {
          await saveIdentity(deps.db, { userId: session.userId, tenantId: session.tenantId, role: session.role });
        }
      } catch (err) {
        await deps.tokens.signOut(origin);
        throw err;
      }
      return { origin, session };
    } catch (err) {
      await deps.tokens.revokeRefreshToken(origin, tokens.refreshToken);
      throw err;
    }
  }

  /** Validates a callback against the pending login and exchanges its code. */
  async function complete(url: string, strict: boolean): Promise<SignInResult | null> {
    const params = parseCallbackUrl(url, CALLBACK_SCHEME);
    if (!params) {
      if (!strict) return null;
      pending = null;
      throw new AuthError('callback_invalid');
    }
    const p = take();
    if (!p) {
      if (!strict) return null;
      throw new AuthError('sign_in_expired');
    }
    if (single(params, 'state') !== p.state) throw new AuthError('callback_invalid');
    if (params.has('error')) throw new AuthError('sign_in_denied');
    const issuers = params.getAll('iss');
    if (issuers.length > 1 || (issuers.length === 1 && issuers[0]?.replace(/\/$/, '') !== p.origin)) throw new AuthError('callback_invalid');
    const code = single(params, 'code');
    if (!code || code.length > MAX_CODE_LENGTH) throw new AuthError('callback_invalid');
    return exchange(p, code);
  }

  async function attempt(origin: string): Promise<SignInResult> {
    let verifier: string;
    let challenge: string;
    try {
      verifier = generateRandomCodeVerifier();
      challenge = await calculatePKCECodeChallenge(verifier);
    } catch {
      throw new AuthError('crypto_unavailable');
    }
    const clientId = await deps.registrar.ensureClientId(origin);
    const state = generateRandomState();
    pending = { state, verifier, origin, clientId, createdAt: deps.clock.now() };
    let callback: string;
    try {
      callback = await deps.authSession.start(buildAuthorizeUrl({ origin, clientId, challenge, state }), CALLBACK_SCHEME);
    } catch (err) {
      pending = null;
      throw isAuthError(err) ? err : new AuthError('sign_in_failed');
    }
    const result = await complete(callback, true);
    if (!result) throw new AuthError('sign_in_failed');
    return result;
  }

  async function run(origin: string): Promise<SignInResult> {
    for (let retried = false; ; retried = true) {
      try {
        return await attempt(origin);
      } catch (err) {
        pending = null;
        if (!(err instanceof ClientRejected)) throw err;
        if (retried) throw new AuthError('registration_failed');
        await deps.registrar.forget(origin);
      }
    }
  }

  return {
    signIn: (origin) => {
      if (running) return running;
      const started = run(origin);
      const clear = (): void => {
        running = null;
      };
      started.then(clear, clear);
      running = started;
      return started;
    },
    handleCallback: async (url) => {
      try {
        return await complete(url, false);
      } catch (err) {
        if (err instanceof ClientRejected) throw new AuthError('registration_failed');
        throw err;
      }
    },
    hasPending: () => pending !== null && deps.clock.now() - pending.createdAt <= ttl,
  };
}
