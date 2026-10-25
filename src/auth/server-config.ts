import type { Db } from '../platform/db';
import { assertDeviceStateKey } from '../platform/schema';
import { AuthError } from './errors';
import type { Http } from './http';

/**
 * The lowest `serverContractVersion` (from `GET /api/client/compat`) this app can sync with, and the one place it is written.
 * A server below it is "too old": the app keeps local reads, edits and capture working and starts no sync flow
 * (see `serverTooOld` in `ClientState`). Raise it, in the same change, when the app starts to depend on a server route or
 * field that an earlier contract version does not have; never raise it for a feature that can degrade by itself
 * (the engine's version history is in its native client guide). A server that does not answer is not "too old":
 * the answer is unknown and nothing is blocked.
 */
export const MIN_SERVER_CONTRACT_VERSION = 1;
const COMPAT_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface ParseServerUrlOptions {
  /** Development switch: allows plain http to a non-loopback host (an emulator host alias, a LAN address). */
  allowInsecureHttp?: boolean;
}

/**
 * The only place a typed server address becomes a stored one. Accepts an
 * origin and nothing else, and returns it in canonical form (lower-case host,
 * default port removed, no trailing slash).
 */
export function parseServerUrl(input: string, options: ParseServerUrlOptions = {}): string {
  const fail = (): never => {
    throw new AuthError('invalid_server_url');
  };
  const raw = input.trim();
  if (!raw || raw.length > 2048 || /\s/.test(raw) || raw.includes('?') || raw.includes('#')) return fail();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail();
  }
  if (url.username || url.password || !url.hostname || url.pathname !== '/') return fail();
  if (url.protocol === 'http:') {
    if (!LOOPBACK_HOSTS.has(url.hostname) && !options.allowInsecureHttp) return fail();
  } else if (url.protocol !== 'https:') {
    return fail();
  }
  return url.origin;
}

export interface ServerEndpoints {
  register: string;
  authorize: string;
  token: string;
  compat: string;
  session: string;
}

/** Fixed paths under the configured origin. No discovery document is ever read. */
export function serverEndpoints(origin: string): ServerEndpoints {
  return {
    register: `${origin}/oauth/register`,
    authorize: `${origin}/oauth/authorize`,
    token: `${origin}/oauth/token`,
    compat: `${origin}/api/client/compat`,
    session: `${origin}/api/client/session`,
  };
}

/** Secure-store key of the refresh token for one server. */
export function refreshTokenKey(origin: string): string {
  return `oi.auth.refresh-token:${origin}`;
}

/** `device_state` key of the registered client id for one server. */
export function clientIdKey(origin: string): string {
  return `client_id:${origin}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function nullableString(value: unknown, max: number): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

export interface CompatInfo {
  minSupported: string | null;
  recommended: string | null;
  /** Untrusted: https only, and only to be opened when the user taps it. */
  downloadUrl: string | null;
  serverContractVersion: number;
  /** The server speaks an older contract than this app needs. A state to show, not a login block. */
  serverTooOld: boolean;
  /** Always false: the compat endpoint does not check whether native sign-in is switched on. */
  nativeLoginVerified: false;
}

function httpsOnly(value: string | null): string | null {
  if (value === null) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export async function fetchCompat(
  http: Http,
  origin: string,
  platform: 'android' | 'ios' | 'windows',
  options: { timeoutMs?: number } = {},
): Promise<CompatInfo> {
  const res = await http.request({
    url: `${serverEndpoints(origin).compat}?platform=${platform}`,
    method: 'GET',
    timeoutMs: options.timeoutMs ?? COMPAT_TIMEOUT_MS,
  });
  const body = res.json;
  const data = isRecord(body) && body.success === true && isRecord(body.data) ? body.data : undefined;
  const minSupported = nullableString(data?.minSupported, 64);
  const recommended = nullableString(data?.recommended, 64);
  const downloadUrl = nullableString(data?.downloadUrl, 2048);
  const version = data?.serverContractVersion;
  if (
    res.status !== 200 ||
    minSupported === undefined ||
    recommended === undefined ||
    downloadUrl === undefined ||
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 0
  ) {
    throw new AuthError('server_response_invalid');
  }
  return {
    minSupported,
    recommended,
    downloadUrl: httpsOnly(downloadUrl),
    serverContractVersion: version,
    serverTooOld: version < MIN_SERVER_CONTRACT_VERSION,
    nativeLoginVerified: false,
  };
}

export interface SessionInfo {
  userId: string;
  tenantId: string;
  role: string;
  offlineMaxDays: number;
}

export type SessionResult =
  /**
   * `serverDateMs` is the `Date` header of this very response (epoch ms), or null when absent, unparseable or
   * not exposed to the page by CORS. `serverNowMs` is the optional `serverNowMs` field of the body (epoch ms),
   * or null when absent or implausible.
   */
  | { kind: 'ok'; session: SessionInfo; serverDateMs: number | null; serverNowMs: number | null }
  | { kind: 'unauthorized' };

/** Epoch milliseconds between 2001-09-09 and 5138-11-16: anything else (seconds, a float, text, zero) is not a server clock reading. */
const MIN_PLAUSIBLE_SERVER_NOW_MS = 1e12;
const MAX_PLAUSIBLE_SERVER_NOW_MS = 1e14;

function serverNowMsOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_PLAUSIBLE_SERVER_NOW_MS && value <= MAX_PLAUSIBLE_SERVER_NOW_MS ? value : null;
}

/** `GET /api/client/session` with a Bearer token (no cookies, no credentials mode). */
export async function fetchSession(http: Http, origin: string, accessToken: string): Promise<SessionResult> {
  const res = await http.request({
    url: serverEndpoints(origin).session,
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) return { kind: 'unauthorized' };
  const body = res.json;
  const data = isRecord(body) && body.success === true && isRecord(body.data) ? body.data : undefined;
  const userId = boundedString(data?.userId, 256);
  const tenantId = boundedString(data?.tenantId, 256);
  const role = typeof data?.role === 'string' && data.role.length <= 64 ? data.role : undefined;
  const days = data?.offlineMaxDays;
  if (res.status !== 200 || !userId || !tenantId || role === undefined || typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
    throw new AuthError('server_response_invalid');
  }
  return { kind: 'ok', session: { userId, tenantId, role, offlineMaxDays: days }, serverDateMs: res.serverDateMs, serverNowMs: serverNowMsOf(data?.serverNowMs) };
}

export async function loadClientId(db: Db, origin: string): Promise<string | null> {
  const rows = await db.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [clientIdKey(origin)]);
  return rows[0]?.value ?? null;
}

/** The one place the auth layer writes `device_state`: the key must be a declared one. */
export async function writeDeviceState(db: Db, key: string, value: string): Promise<void> {
  assertDeviceStateKey(key);
  await db.run('INSERT OR REPLACE INTO device_state (key, value) VALUES (?, ?)', [key, value]);
}

export async function saveClientId(db: Db, origin: string, clientId: string): Promise<void> {
  await writeDeviceState(db, clientIdKey(origin), clientId);
}

export async function clearClientId(db: Db, origin: string): Promise<void> {
  await db.run('DELETE FROM device_state WHERE key = ?', [clientIdKey(origin)]);
}

export interface StoredIdentity {
  userId: string;
  tenantId: string;
  role: string;
}

export async function loadIdentity(db: Db): Promise<StoredIdentity | null> {
  const rows = await db.query<{ key: string; value: string }>("SELECT key, value FROM device_state WHERE key IN ('user_id', 'tenant_id', 'role')");
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const { user_id: userId, tenant_id: tenantId, role } = byKey;
  return userId && tenantId && role ? { userId, tenantId, role } : null;
}

export async function saveIdentity(db: Db, identity: StoredIdentity): Promise<void> {
  await db.transaction(async (tx) => {
    await writeDeviceState(tx, 'user_id', identity.userId);
    await writeDeviceState(tx, 'tenant_id', identity.tenantId);
    await writeDeviceState(tx, 'role', identity.role);
  });
}
