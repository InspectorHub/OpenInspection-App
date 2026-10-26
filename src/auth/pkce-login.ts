import { calculatePKCECodeChallenge, generateRandomCodeVerifier, generateRandomState } from 'oauth4webapi';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { CALLBACK_SCHEME, parseCallbackUrl, PENDING_LOGIN_TTL_MS, REDIRECT_URI, type AuthSession } from './auth-session';
import { AuthError, isAuthError } from './errors';
import type { Http } from './http';
import type { Registrar } from './registration';
import { recordVerified, setRevoked } from '../offline/lock-state';
import { fetchSession, loadIdentity, saveIdentity, serverEndpoints, type SessionInfo } from './server-config';
import { NATIVE_SCOPE, oauthErrorCode, parseTokenResponse, type TokenManager, type TokenResponse } from './tokens';

export { PENDING_LOGIN_TTL_MS };
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
  /**
   * Runs one sign-in. A second call for the same origin while one is running returns the
   * same promise; a call for another origin rejects `sign_in_in_progress`.
   */
  signIn(origin: string): Promise<SignInResult>;
  /**
   * Feeds a callback URL that arrived outside the auth session's own listener. When a login is
   * waiting for it the URL is handed to that login and the returned promise is that login's own
   * outcome, so the login settles exactly once. Returns null, with no network call and no state
   * change, when the URL is not the callback or no login is waiting for it.
   */
  handleCallback(url: string): Promise<SignInResult | null>;
  hasPending(): boolean;
  /** Ends a login that is waiting for its callback, as `sign_in_cancelled`. For the UI's cancel button. */
  cancel(): void;
  /**
   * The browser reported that it closed. The login is still alive (the callback may be on its way);
   * a UI can use this to offer a cancel button. Returns an unsubscribe function.
   */
  onBrowserClosed(listener: () => void): () => void;
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
  /** Hands the login a callback URL that reached the app by another route. */
  deliver(url: string): void;
}

/** One login, retries included; `cancelled` is set by the UI's cancel, wherever the login has got to. */
interface Attempt {
  cancelled: boolean;
}

function single(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length === 1 ? (all[0] ?? null) : null;
}

export function createLoginFlow(deps: LoginDeps): LoginFlow {
  const ttl = deps.ttlMs ?? PENDING_LOGIN_TTL_MS;
  let pending: Pending | null = null;
  let running: Promise<SignInResult> | null = null;
  let runningOrigin: string | null = null;
  let current: Attempt | null = null;

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
      const stored = await loadIdentity(deps.db);
      const sameIdentity = stored !== null && stored.userId === session.userId && stored.tenantId === session.tenantId;
      if (!ALLOWED_ROLES.includes(session.role)) {
        // The server knows this person and refuses their role for the app. If their data is on this device,
        // it stays but cannot be used or uploaded: the same lock a removed member gets.
        if (sameIdentity) await setRevoked(deps.db).catch(() => undefined);
        throw new AuthError('session_role_not_allowed');
      }
      if (stored && !sameIdentity) throw new AuthError('identity_mismatch');
      await deps.tokens.adopt(origin, tokens);
      try {
        if (!stored || stored.role !== session.role) {
          await saveIdentity(deps.db, { userId: session.userId, tenantId: session.tenantId, role: session.role });
        }
        await recordVerified(deps.db, deps.clock.now(), session.offlineMaxDays, result.serverDateMs, result.serverNowMs);
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
  async function complete(url: string): Promise<SignInResult> {
    const params = parseCallbackUrl(url, CALLBACK_SCHEME);
    if (!params) {
      pending = null;
      throw new AuthError('callback_invalid');
    }
    // The state is compared before the pending login is taken: a callback that is not ours must not use it up.
    if (pending && single(params, 'state') !== pending.state) throw new AuthError('callback_invalid');
    const p = take();
    if (!p) throw new AuthError('sign_in_expired');
    if (params.has('error')) throw new AuthError('sign_in_denied');
    const issuers = params.getAll('iss');
    if (issuers.length > 1 || (issuers.length === 1 && issuers[0]?.replace(/\/$/, '') !== p.origin)) throw new AuthError('callback_invalid');
    const code = single(params, 'code');
    if (!code || code.length > MAX_CODE_LENGTH) throw new AuthError('callback_invalid');
    return exchange(p, code);
  }

  async function runAttempt(origin: string, mine: Attempt): Promise<SignInResult> {
    let verifier: string;
    let challenge: string;
    try {
      verifier = generateRandomCodeVerifier();
      challenge = await calculatePKCECodeChallenge(verifier);
    } catch {
      throw new AuthError('crypto_unavailable');
    }
    const clientId = await deps.registrar.ensureClientId(origin);
    // A cancel that landed while the client id was being ensured must stop the browser from opening.
    if (mine.cancelled) throw new AuthError('sign_in_cancelled');
    const state = generateRandomState();
    let delivered: (url: string) => void = () => undefined;
    let fromDelivery = false;
    const delivery = new Promise<string>((resolve) => {
      delivered = resolve;
    });
    pending = {
      state,
      verifier,
      origin,
      clientId,
      createdAt: deps.clock.now(),
      deliver: (url) => {
        fromDelivery = true;
        delivered(url);
      },
    };
    let callback: string;
    try {
      const accept = (url: string): boolean => single(parseCallbackUrl(url, CALLBACK_SCHEME) ?? new URLSearchParams(), 'state') === state;
      callback = await Promise.race([deps.authSession.start(buildAuthorizeUrl({ origin, clientId, challenge, state }), CALLBACK_SCHEME, accept), delivery]);
    } catch (err) {
      pending = null;
      throw isAuthError(err) ? err : new AuthError('sign_in_failed');
    }
    // The callback came through `handleCallback`, so the session may still be waiting: release it.
    if (fromDelivery) deps.authSession.cancel();
    return complete(callback);
  }

  async function run(origin: string): Promise<SignInResult> {
    // One record for the whole login, retry included: a cancel between two attempts must not be lost.
    const mine: Attempt = { cancelled: false };
    current = mine;
    try {
      for (let retried = false; ; retried = true) {
        try {
          return await runAttempt(origin, mine);
        } catch (err) {
          pending = null;
          if (!(err instanceof ClientRejected)) throw err;
          if (retried) throw new AuthError('registration_failed');
          await deps.registrar.forget(origin);
          // Without this, a cancel during the forget still registers a replacement client before the next attempt notices.
          if (mine.cancelled) throw new AuthError('sign_in_cancelled');
        }
      }
    } finally {
      if (current === mine) current = null;
    }
  }

  return {
    signIn: (origin) => {
      if (running) return runningOrigin === origin ? running : Promise.reject(new AuthError('sign_in_in_progress'));
      const started = run(origin);
      const clear = (): void => {
        running = null;
        runningOrigin = null;
      };
      started.then(clear, clear);
      running = started;
      runningOrigin = origin;
      return started;
    },
    handleCallback: (url) => {
      if (!parseCallbackUrl(url, CALLBACK_SCHEME)) return Promise.resolve(null);
      const waiting = pending;
      if (!waiting || !running || deps.clock.now() - waiting.createdAt > ttl) return Promise.resolve(null);
      // A URL that carries someone else's state is not an answer to this login: leave the login pending.
      if (single(parseCallbackUrl(url, CALLBACK_SCHEME) ?? new URLSearchParams(), 'state') !== waiting.state) return Promise.resolve(null);
      waiting.deliver(url);
      return running;
    },
    hasPending: () => pending !== null && deps.clock.now() - pending.createdAt <= ttl,
    cancel: () => {
      if (current) current.cancelled = true;
      deps.authSession.cancel();
    },
    onBrowserClosed: (listener) => deps.authSession.onBrowserClosed(listener),
  };
}
