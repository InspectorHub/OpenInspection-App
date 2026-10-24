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
  | 'backoff';

export type RefreshResult =
  | { kind: 'ok'; accessToken: string; expiresAt: number }
  | { kind: 'relogin' }
  | { kind: 'signed_out' }
  | { kind: 'retry'; reason: RetryReason; retryAfterMs: number };

export type FailureClass = { kind: 'relogin' } | { kind: 'retry'; reason: Exclude<RetryReason, 'network' | 'timeout' | 'storage' | 'backoff'>; retryAfterMs: number | null };

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
  if (body.scope === undefined ? requireScope : body.scope !== NATIVE_SCOPE) return { ok: false, reason: 'scope', refreshToken };
  return { ok: true, tokens: { accessToken, refreshToken, expiresInSec: expires } };
}

export interface TokenDeps {
  http: Http;
  store: SecureStore;
  clock: Clock;
  getClientId(origin: string): Promise<string | null>;
  random?: () => number;
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
  /** `/api/client/session` with a fresh token; a 401 that survives one refresh means the session is over. */
  checkSession(origin: string): Promise<SessionCheck>;
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

export function createTokenManager(deps: TokenDeps): TokenManager {
  const random = deps.random ?? Math.random;
  const generations = new Map<string, number>();
  const flights = new Map<string, Promise<RefreshResult>>();
  const relogin = new Set<string>();
  const backoff = new Map<string, { until: number; attempt: number }>();
  let activeOrigin: string | null = null;
  let access: { token: string; expiresAt: number } | null = null;

  const generationOf = (origin: string): number => generations.get(origin) ?? 0;

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
      current = await deps.store.get(key);
    } catch {
      return retry(origin, 'storage', null);
    }
    if (!current) return { kind: 'signed_out' };
    const clientId = await deps.getClientId(origin);
    if (!clientId) return { kind: 'relogin' };

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
        if (generationOf(origin) !== generation) return { kind: 'signed_out' };
        relogin.add(origin);
        if (activeOrigin === origin) access = null;
        return { kind: 'relogin' };
      }
      return retry(origin, failure.reason, failure.retryAfterMs);
    }

    const parsed = parseTokenResponse(res.json, false);
    if (!parsed.ok) return retry(origin, 'malformed', null);
    const next = parsed.tokens;

    if (generationOf(origin) !== generation) {
      // Signed out while the request was in flight: the server has already rotated the grant,
      // so the new token is the live one. Revoke it and store nothing.
      await revoke(origin, next.refreshToken);
      return { kind: 'signed_out' };
    }

    try {
      await deps.store.set(key, next.refreshToken);
    } catch {
      // The old token stays; the server accepts it once more.
      return retry(origin, 'storage', null);
    }

    const expiresAt = deps.clock.now() + next.expiresInSec * 1000;
    if (activeOrigin === origin) access = { token: next.accessToken, expiresAt };
    relogin.delete(origin);
    backoff.delete(origin);
    return { kind: 'ok', accessToken: next.accessToken, expiresAt };
  }

  function refresh(origin: string, options: { ignoreBackoff?: boolean } = {}): Promise<RefreshResult> {
    useOrigin(origin);
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
    if (access && access.expiresAt - REFRESH_EARLY_MS > deps.clock.now()) return access.token;
    const result = await refresh(origin);
    return result.kind === 'ok' ? result.accessToken : null;
  }

  async function checkSession(origin: string): Promise<SessionCheck> {
    useOrigin(origin);
    if (access && access.expiresAt - REFRESH_EARLY_MS > deps.clock.now()) return checkWith(origin, access.token);
    const refreshed = await refresh(origin);
    return refreshed.kind === 'ok' ? checkWith(origin, refreshed.accessToken) : refreshed;
  }

  async function checkWith(origin: string, accessToken: string): Promise<SessionCheck> {
    try {
      const result = await fetchSession(deps.http, origin, accessToken);
      if (result.kind === 'ok') return result;
      const again = await refresh(origin, { ignoreBackoff: true });
      if (again.kind !== 'ok') return again;
      const second = await fetchSession(deps.http, origin, again.accessToken);
      if (second.kind === 'ok') return second;
      relogin.add(origin);
      access = null;
      return { kind: 'relogin' };
    } catch (err) {
      return retry(origin, isAuthError(err) && err.code === 'server_timeout' ? 'timeout' : 'network', null);
    }
  }

  return {
    adopt: async (origin, tokens) => {
      useOrigin(origin);
      try {
        await deps.store.set(refreshTokenKey(origin), tokens.refreshToken);
      } catch {
        throw new AuthError('storage_failed');
      }
      access = { token: tokens.accessToken, expiresAt: deps.clock.now() + tokens.expiresInSec * 1000 };
      relogin.delete(origin);
      backoff.delete(origin);
    },
    getAccessToken,
    refresh,
    checkSession,
    getState: async (origin) => {
      if (relogin.has(origin)) return 'relogin_required';
      return (await deps.store.get(refreshTokenKey(origin))) ? 'signed_in' : 'signed_out';
    },
    useOrigin,
    signOut: async (origin) => {
      generations.set(origin, generationOf(origin) + 1);
      await flights.get(origin)?.catch(() => undefined);
      const key = refreshTokenKey(origin);
      const stored = await deps.store.get(key).catch(() => null);
      try {
        await deps.store.remove(key);
      } catch {
        throw new AuthError('storage_failed');
      }
      relogin.delete(origin);
      backoff.delete(origin);
      if (activeOrigin === origin) access = null;
      if (stored) await revoke(origin, stored);
    },
    revokeRefreshToken: (origin, refreshToken) => revoke(origin, refreshToken),
  };
}
