import type { Clock } from '../platform/clock';
import type { SecureStore } from '../platform/secure-store';
import { AuthError, isAuthError } from './errors';
import type { Http } from './http';
import { fetchSession, refreshTokenKey, serverEndpoints, type SessionInfo } from './server-config';

export const NATIVE_SCOPE = 'native';
/** Refresh this long before the access token expires, by the local clock. */
export const REFRESH_EARLY_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 300_000;
const REVOKE_TIMEOUT_MS = 5_000;
/** How long one secure-store call may take before it is given up on. */
export const STORE_TIMEOUT_MS = 10_000;
const MAX_TOKEN_LENGTH = 4096;
const MAX_EXPIRES_IN_SEC = 31_536_000;

export type AuthState = 'signed_out' | 'signed_in' | 'relogin_required';

export type RetryReason =
  | 'network'
  | 'timeout'
  | 'server'
  | 'rate_limited'
  | 'unavailable'
  | 'upgrade_required'
  | 'malformed'
  | 'storage'
  | 'backoff'
  /** A newer sign-in replaced the session this check was looking at; ask again. */
  | 'superseded';

export type RefreshResult =
  | { kind: 'ok'; accessToken: string; expiresAt: number }
  | { kind: 'relogin' }
  | { kind: 'signed_out' }
  | { kind: 'retry'; reason: RetryReason; retryAfterMs: number };

export type FailureClass = { kind: 'relogin' } | { kind: 'retry'; reason: Exclude<RetryReason, 'network' | 'timeout' | 'storage' | 'backoff' | 'superseded'>; retryAfterMs: number | null };

/** The OAuth `error` code of an error body, or null. Never the description. */
export function oauthErrorCode(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string') return parsed.error;
  } catch {
    return null;
  }
  return null;
}

/**
 * Decides what a token-endpoint answer means. Only a definite refusal of the
 * grant (400 invalid_grant, invalid_client, unauthorized_client, or a 401)
 * ends the session; everything else leaves the user signed in and retries.
 */
export function classifyTokenFailure(status: number, text: string, retryAfterMs: number | null): FailureClass {
  const code = oauthErrorCode(text);
  if (status === 401) return { kind: 'relogin' };
  if (status === 400 && (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client')) return { kind: 'relogin' };
  if (status === 429) return { kind: 'retry', reason: 'rate_limited', retryAfterMs };
  if (status === 426) return { kind: 'retry', reason: 'upgrade_required', retryAfterMs };
  if (status === 503) return { kind: 'retry', reason: 'unavailable', retryAfterMs };
  if (status >= 500) return { kind: 'retry', reason: 'server', retryAfterMs };
  return { kind: 'retry', reason: 'malformed', retryAfterMs };
}

/** `Retry-After` wins; otherwise exponential growth with jitter, capped. */
export function backoffMs(attempt: number, retryAfterMs: number | null, random: () => number = Math.random): number {
  if (retryAfterMs !== null && retryAfterMs > 0) return retryAfterMs;
  const exponential = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_CAP_MS);
  return Math.round(exponential * (0.5 + 0.5 * random()));
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
}

export type TokenResponseResult =
  | { ok: true; tokens: TokenResponse }
  | { ok: false; reason: 'malformed' }
  /** The grant exists server-side with the wrong scope; its refresh token is returned so it can be revoked. */
  | { ok: false; reason: 'scope'; refreshToken: string };

function token(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_LENGTH ? value : undefined;
}

/** Validates a 200 answer from the token endpoint. `requireScope` is for the first sign-in. */
export function parseTokenResponse(json: unknown, requireScope: boolean): TokenResponseResult {
  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'malformed' };
  const body = json as Record<string, unknown>;
  const accessToken = token(body.access_token);
  const refreshToken = token(body.refresh_token);
  const expires = body.expires_in;
  if (
    !accessToken ||
    !refreshToken ||
    typeof body.token_type !== 'string' ||
    body.token_type.toLowerCase() !== 'bearer' ||
    typeof expires !== 'number' ||
    !Number.isFinite(expires) ||
    expires <= 0 ||
    expires > MAX_EXPIRES_IN_SEC
  ) {
    return { ok: false, reason: 'malformed' };
  }
  // A missing scope is acceptable on a refresh (the grant keeps its scope) but not on the first sign-in.
  const scopeAcceptable = body.scope === undefined ? !requireScope : body.scope === NATIVE_SCOPE;
  if (!scopeAcceptable) return { ok: false, reason: 'scope', refreshToken };
  return { ok: true, tokens: { accessToken, refreshToken, expiresInSec: expires } };
}

const globalTimers: NonNullable<TokenDeps['timers']> = {
  setTimeout: ((...args: Parameters<typeof setTimeout>) => setTimeout(...args)) as typeof setTimeout,
  clearTimeout: ((...args: Parameters<typeof clearTimeout>) => clearTimeout(...args)) as typeof clearTimeout,
};

export interface TokenDeps {
  http: Http;
  store: SecureStore;
  clock: Clock;
  getClientId(origin: string): Promise<string | null>;
  random?: () => number;
  /** Bounds every secure-store call; defaults to `STORE_TIMEOUT_MS`. */
  storeTimeoutMs?: number;
  /** Timer functions for that bound; default to the globals. */
  timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  /**
   * Called after the server accepted this device. `sessionConfirmed` is true when the session endpoint
   * answered ok (`offlineMaxDays` is then the tenant's limit, and `serverDateMs` the `Date` header of
   * that response or null, and `serverNowMs` the optional body field of it or null); false for a token refresh alone, which
   * proves the grant is alive but not that the device is still allowed, so it must not undo a
   * revocation (`offlineMaxDays` is null then).
   * Best effort: a failure here is swallowed, which can only leave the offline lock stricter.
   */
  onVerified?(event: { at: number; offlineMaxDays: number | null; sessionConfirmed: boolean; serverDateMs: number | null; serverNowMs: number | null }): Promise<void> | void;
  /**
   * Called when the session endpoint kept answering 401 after a successful token refresh: the only
   * definitive "this device is no longer allowed" signal. A refresh that is refused (400 invalid_grant)
   * does not call this: the server answers that way for a removed member, a role change and a password
   * change alike, and the client cannot tell them apart.
   */
  onRevoked?(): Promise<void> | void;
}

export type SessionCheck =
  | { kind: 'ok'; session: SessionInfo }
  | { kind: 'relogin' }
  | { kind: 'signed_out' }
  | { kind: 'retry'; reason: RetryReason; retryAfterMs: number };

export interface TokenManager {
  /** Stores the tokens of a completed sign-in: the refresh token first, then the in-memory access token. */
  adopt(origin: string, tokens: TokenResponse): Promise<void>;
  /** The access token for `origin`, refreshing when it is close to expiry; null when there is none to give. */
  getAccessToken(origin: string): Promise<string | null>;
  refresh(origin: string, options?: { ignoreBackoff?: boolean }): Promise<RefreshResult>;
  /**
   * `/api/client/session` with a fresh token; a 401 that survives one refresh means the session is over.
   * A server-set backoff holds the check back; `ignoreBackoff` is for an explicit user action (a pull to
   * refresh, a "try again" tap), which must not wait out a Retry-After the user cannot see.
   */
  checkSession(origin: string, options?: { ignoreBackoff?: boolean }): Promise<SessionCheck>;
  getState(origin: string): Promise<AuthState>;
  /** Makes `origin` the active server, dropping any in-memory token that belonged to another. */
  useOrigin(origin: string): void;
  /** Wipes this server's tokens only; local data is not reachable from here. */
  signOut(origin: string): Promise<void>;
  /** Best-effort RFC 7009 revocation of a refresh token that is not (or no longer) stored. */
  revokeRefreshToken(origin: string, refreshToken: string): Promise<void>;
}

function formBody(values: Record<string, string>): { headers: Record<string, string>; body: string } {
  return { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(values).toString() };
}

/**
 * One token manager serves one app. `adopt` and `signOut` for the same origin must not be interleaved by
 * callers: the UI runs them one at a time (a sign-in screen and a signed-in screen are never up together).
 *
 * Every secure-store call is bounded (`storeTimeoutMs`). A call that never answers is treated as a failed
 * one: `adopt` and `signOut` reject `storage_failed`, a refresh answers `retry`/`storage`, and the markers
 * that guard the origin are always released. A write that was abandoned this way may still land later;
 * the store gives no way to cancel it.
 */
export function createTokenManager(deps: TokenDeps): TokenManager {
  const random = deps.random ?? Math.random;
  const storeTimeoutMs = deps.storeTimeoutMs ?? STORE_TIMEOUT_MS;
  /** Rejects when `call` has not settled in time; the timer never outlives the call. */
  function bounded<T>(call: () => Promise<T>): Promise<T> {
    // Arrow wrappers, not the bare builtins: a WebView throws `Illegal invocation` when they run with another `this`.
    const timers = deps.timers ?? globalTimers;
    return new Promise<T>((resolve, reject) => {
      const timer = timers.setTimeout(() => {
        reject(new Error('secure store timed out'));
      }, storeTimeoutMs);
      call().then(
        (value) => {
          timers.clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          timers.clearTimeout(timer);
          reject(err instanceof Error ? err : new Error('secure store failed'));
        },
      );
    });
  }
  const storeGet = (key: string): Promise<string | null> => bounded(() => deps.store.get(key));
  const storeSet = (key: string, value: string): Promise<void> => bounded(() => deps.store.set(key, value));
  const storeRemove = (key: string): Promise<void> => bounded(() => deps.store.remove(key));
  const generations = new Map<string, number>();
  const flights = new Map<string, Promise<RefreshResult>>();
  const relogin = new Set<string>();
  /** Origins whose sign-out has started and not yet finished (a count, so overlapping sign-outs nest). */
  const signingOut = new Map<string, number>();
  /** How many sign-outs have begun for an origin, ever: a check that started earlier knows it was signed out. */
  const signOutEpochs = new Map<string, number>();
  /** Origins whose sign-in is storing its token; settles once the write finished or failed. */
  const adopting = new Map<string, Promise<void>>();
  const backoff = new Map<string, { until: number; attempt: number }>();
  let activeOrigin: string | null = null;
  let access: { token: string; expiresAt: number } | null = null;

  async function notify(call: (() => Promise<void> | void) | undefined): Promise<void> {
    try {
      await call?.();
    } catch {
      // Recording is best effort; see the hook documentation.
    }
  }
  const refreshed = (): Promise<void> => notify(() => deps.onVerified?.({ at: deps.clock.now(), offlineMaxDays: null, sessionConfirmed: false, serverDateMs: null, serverNowMs: null }));
  const sessionConfirmed = (offlineMaxDays: number, serverDateMs: number | null, serverNowMs: number | null): Promise<void> =>
    notify(() => deps.onVerified?.({ at: deps.clock.now(), offlineMaxDays, sessionConfirmed: true, serverDateMs, serverNowMs }));

  const generationOf = (origin: string): number => generations.get(origin) ?? 0;
  const bumpGeneration = (origin: string): void => {
    generations.set(origin, generationOf(origin) + 1);
  };
  const isSigningOut = (origin: string): boolean => (signingOut.get(origin) ?? 0) > 0;
  const signOutEpochOf = (origin: string): number => signOutEpochs.get(origin) ?? 0;
  /** True when the flight that started at `generation` has been overtaken by a sign-out or a new sign-in. */
  const superseded = (origin: string, generation: number): boolean => generationOf(origin) !== generation || isSigningOut(origin);

  function useOrigin(origin: string): void {
    if (activeOrigin !== origin) access = null;
    activeOrigin = origin;
  }

  async function revoke(origin: string, refreshToken: string): Promise<void> {
    try {
      const clientId = await deps.getClientId(origin);
      if (!clientId) return;
      await deps.http.request({
        url: serverEndpoints(origin).token,
        method: 'POST',
        timeoutMs: REVOKE_TIMEOUT_MS,
        ...formBody({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
      });
    } catch {
      // Revocation is best effort: the server also expires idle grants.
    }
  }

  function retry(origin: string, reason: RetryReason, retryAfterMs: number | null): Extract<RefreshResult, { kind: 'retry' }> {
    const attempt = (backoff.get(origin)?.attempt ?? 0) + 1;
    const delay = backoffMs(attempt, retryAfterMs, random);
    backoff.set(origin, { until: deps.clock.now() + delay, attempt });
    return { kind: 'retry', reason, retryAfterMs: delay };
  }

  async function runRefresh(origin: string, generation: number): Promise<RefreshResult> {
    const key = refreshTokenKey(origin);
    let current: string | null;
    try {
      current = await storeGet(key);
    } catch {
      return retry(origin, 'storage', null);
    }
    if (!current) return { kind: 'signed_out' };
    let clientId: string | null;
    try {
      clientId = await deps.getClientId(origin);
    } catch {
      return retry(origin, 'storage', null);
    }
    if (!clientId) return { kind: 'relogin' };
    // Sign-out may have begun while the key and the client id were being read: nothing may be posted then.
    if (superseded(origin, generation)) return { kind: 'signed_out' };

    let res;
    try {
      res = await deps.http.request({
        url: serverEndpoints(origin).token,
        method: 'POST',
        ...formBody({ grant_type: 'refresh_token', refresh_token: current, client_id: clientId }),
      });
    } catch (err) {
      const reason: RetryReason = isAuthError(err) && err.code === 'server_timeout' ? 'timeout' : 'network';
      return retry(origin, reason, null);
    }

    if (res.status !== 200) {
      const failure = classifyTokenFailure(res.status, res.text, res.retryAfterMs);
      if (failure.kind === 'relogin') {
        if (superseded(origin, generation)) return { kind: 'signed_out' };
        relogin.add(origin);
        if (activeOrigin === origin) access = null;
        return { kind: 'relogin' };
      }
      return retry(origin, failure.reason, failure.retryAfterMs);
    }

    const parsed = parseTokenResponse(res.json, false);
    if (!parsed.ok) return retry(origin, 'malformed', null);
    const next = parsed.tokens;

    if (superseded(origin, generation)) {
      // Signed out while the request was in flight: the server has already rotated the grant,
      // so the new token is the live one. Revoke it and store nothing.
      await revoke(origin, next.refreshToken);
      return { kind: 'signed_out' };
    }

    try {
      await storeSet(key, next.refreshToken);
    } catch {
      // The old token stays; the server accepts it once more.
      return retry(origin, 'storage', null);
    }

    if (superseded(origin, generation)) return { kind: 'signed_out' };
    const expiresAt = deps.clock.now() + next.expiresInSec * 1000;
    if (activeOrigin === origin) access = { token: next.accessToken, expiresAt };
    relogin.delete(origin);
    backoff.delete(origin);
    await refreshed();
    return { kind: 'ok', accessToken: next.accessToken, expiresAt };
  }

  function refresh(origin: string, options: { ignoreBackoff?: boolean } = {}): Promise<RefreshResult> {
    useOrigin(origin);
    if (isSigningOut(origin)) return Promise.resolve({ kind: 'signed_out' });
    // A new sign-in is writing its token: wait for it, then refresh with the token it stored.
    const adoption = adopting.get(origin);
    if (adoption) return adoption.then(() => refresh(origin, options));
    const running = flights.get(origin);
    if (running) return running;
    const waiting = backoff.get(origin);
    if (!options.ignoreBackoff && waiting && deps.clock.now() < waiting.until) {
      return Promise.resolve({ kind: 'retry', reason: 'backoff', retryAfterMs: waiting.until - deps.clock.now() });
    }
    const flight = runRefresh(origin, generationOf(origin)).finally(() => {
      flights.delete(origin);
    });
    flights.set(origin, flight);
    return flight;
  }

  async function getAccessToken(origin: string): Promise<string | null> {
    useOrigin(origin);
    if (isSigningOut(origin)) return null;
    if (access && access.expiresAt - REFRESH_EARLY_MS > deps.clock.now()) return access.token;
    const result = await refresh(origin);
    return result.kind === 'ok' ? result.accessToken : null;
  }

  async function checkSession(origin: string, options: { ignoreBackoff?: boolean } = {}): Promise<SessionCheck> {
    useOrigin(origin);
    if (isSigningOut(origin)) return { kind: 'signed_out' };
    if (access && access.expiresAt - REFRESH_EARLY_MS > deps.clock.now()) return checkWith(origin, access.token);
    const refreshed = await refresh(origin, options);
    return refreshed.kind === 'ok' ? checkWith(origin, refreshed.accessToken) : refreshed;
  }

  async function checkWith(origin: string, accessToken: string): Promise<SessionCheck> {
    const generation = generationOf(origin);
    const epoch = signOutEpochOf(origin);
    /**
     * A sign-out (finished or not) or a new sign-in during the awaits makes any verdict stale, and a stale
     * answer must neither be recorded nor revoke. The two differ: after a sign-out the user is signed out;
     * after a new sign-in the answer is not known yet, and the user who just signed in must not be told
     * they are signed out.
     */
    const overtaken = (): SessionCheck | null => {
      if (signOutEpochOf(origin) !== epoch || isSigningOut(origin)) return { kind: 'signed_out' };
      if (generationOf(origin) !== generation) return { kind: 'retry', reason: 'superseded', retryAfterMs: 0 };
      return null;
    };
    try {
      const result = await fetchSession(deps.http, origin, accessToken);
      if (result.kind === 'ok') {
        const stale = overtaken();
        if (stale) return stale;
        await sessionConfirmed(result.session.offlineMaxDays, result.serverDateMs, result.serverNowMs);
        return result;
      }
      const again = await refresh(origin, { ignoreBackoff: true });
      if (again.kind !== 'ok') return again;
      const second = await fetchSession(deps.http, origin, again.accessToken);
      const stale = overtaken();
      if (stale) return stale;
      if (second.kind === 'ok') {
        await sessionConfirmed(second.session.offlineMaxDays, second.serverDateMs, second.serverNowMs);
        return second;
      }
      relogin.add(origin);
      if (activeOrigin === origin) access = null;
      await notify(() => deps.onRevoked?.());
      return { kind: 'relogin' };
    } catch (err) {
      return retry(origin, isAuthError(err) && err.code === 'server_timeout' ? 'timeout' : 'network', null);
    }
  }

  return {
    adopt: (origin, tokens) => {
      useOrigin(origin);
      // A refresh that began before this sign-in belongs to the previous grant: supersede it, and let it
      // finish (it stores nothing and revokes what it rotated) before the new token is written.
      bumpGeneration(origin);
      const running = flights.get(origin);
      // Adopts of one origin run one after another, so an older write can never land after a newer one.
      const earlier = adopting.get(origin);
      const write = (async (): Promise<void> => {
        await earlier;
        await running?.catch(() => undefined);
        try {
          await storeSet(refreshTokenKey(origin), tokens.refreshToken);
        } catch {
          throw new AuthError('storage_failed');
        }
        access = { token: tokens.accessToken, expiresAt: deps.clock.now() + tokens.expiresInSec * 1000 };
        relogin.delete(origin);
        backoff.delete(origin);
      })();
      // Until the write settles, a refresh would read the previous token; it waits instead.
      const settled = write.then(
        () => undefined,
        () => undefined,
      );
      adopting.set(origin, settled);
      void settled.then(() => {
        if (adopting.get(origin) === settled) adopting.delete(origin);
      });
      return write;
    },
    getAccessToken,
    refresh,
    checkSession,
    getState: async (origin) => {
      if (isSigningOut(origin)) return 'signed_out';
      if (relogin.has(origin)) return 'relogin_required';
      return (await storeGet(refreshTokenKey(origin))) ? 'signed_in' : 'signed_out';
    },
    useOrigin,
    signOut: async (origin) => {
      // The marker goes up before the first await and comes down only after the remove, so no refresh can
      // read the key, post it and store a rotated token in the gap.
      signingOut.set(origin, (signingOut.get(origin) ?? 0) + 1);
      signOutEpochs.set(origin, signOutEpochOf(origin) + 1);
      bumpGeneration(origin);
      let stored: string | null;
      try {
        // A sign-in that is still writing its token finishes first, so the remove below takes it too and
        // the revoke covers its grant: nothing may be stored after sign-out has returned.
        await adopting.get(origin);
        await flights.get(origin)?.catch(() => undefined);
        const key = refreshTokenKey(origin);
        stored = await storeGet(key).catch(() => null);
        try {
          await storeRemove(key);
        } catch {
          throw new AuthError('storage_failed');
        }
        relogin.delete(origin);
        backoff.delete(origin);
        if (activeOrigin === origin) access = null;
        bumpGeneration(origin);
      } finally {
        const left = (signingOut.get(origin) ?? 1) - 1;
        if (left > 0) signingOut.set(origin, left);
        else signingOut.delete(origin);
      }
      if (stored) await revoke(origin, stored);
    },
    revokeRefreshToken: (origin, refreshToken) => revoke(origin, refreshToken),
  };
}
