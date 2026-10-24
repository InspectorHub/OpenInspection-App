import { Capacitor } from '@capacitor/core';
import { createCapacitorAuthSession, type AuthSession } from '../auth/auth-session';
import { createHttp, type FetchLike, type Http } from '../auth/http';
import { createLoginFlow, type LoginFlow } from '../auth/pkce-login';
import { createRegistrar, type Registrar } from '../auth/registration';
import { loadClientId } from '../auth/server-config';
import { createTokenManager, type TokenManager } from '../auth/tokens';
import { systemClock, type Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { closeRealCapacitorDb, openRealCapacitorDb } from '../platform/db-capacitor';
import { createRealFiles, type Files } from '../platform/files';
import { createRealSecureStore, type SecureStore } from '../platform/secure-store';
import { recordRefreshed, recordVerified, setRevoked } from '../offline/lock-state';

export type ClientPlatform = 'android' | 'ios';

export const DATABASE_NAME = 'inspectorhub';

/** Everything the screens use. Built once per launch, by `composeReal` or, in tests, by `composeWith`. */
export interface AppServices {
  db: Db;
  files: Files;
  http: Http;
  registrar: Registrar;
  tokens: TokenManager;
  flow: LoginFlow;
  clock: Clock;
  platform: ClientPlatform;
  appVersion: string;
  /** Releases the database connection. Safe to call when it is already closed. */
  close(): Promise<void>;
}

export interface ComposeParts {
  db: Db;
  files: Files;
  store: SecureStore;
  fetch: FetchLike;
  authSession: AuthSession;
  clock: Clock;
  platform: ClientPlatform;
  appVersion: string;
  closeDb?: () => Promise<void>;
}

/** The wiring, with every adapter supplied. Tests pass fakes; `composeReal` passes the device's. */
export function composeWith(parts: ComposeParts): AppServices {
  const { db, files, store, clock, platform, appVersion } = parts;
  const http = createHttp({
    fetch: parts.fetch,
    defaultHeaders: { 'X-Client-Platform': platform, 'X-Client-Version': appVersion },
  });
  const registrar = createRegistrar({ http, db });
  const tokens = createTokenManager({
    http,
    store,
    clock,
    getClientId: (origin) => loadClientId(db, origin),
    onVerified: (event) => (event.sessionConfirmed ? recordVerified(db, event.at, event.offlineMaxDays, event.serverDateMs) : recordRefreshed(db, event.at)),
    onRevoked: () => setRevoked(db),
  });
  const flow = createLoginFlow({ http, db, registrar, tokens, authSession: parts.authSession, clock });
  return { db, files, http, registrar, tokens, flow, clock, platform, appVersion, close: parts.closeDb ?? (() => Promise.resolve()) };
}

/** Anything that is not iOS reports as Android, which includes the browser used for development. */
export function toClientPlatform(capacitorPlatform: string): ClientPlatform {
  return capacitorPlatform === 'ios' ? 'ios' : 'android';
}

/** The device adapters `composeReal` opens; tests substitute fakes. */
export interface RealAdapters {
  openDb(): Promise<Db>;
  closeDb(): Promise<void>;
  openStore(): Promise<SecureStore>;
}

/** The page's `fetch`, called bare: a WebView throws `Illegal invocation` if it is called as a method of another object. */
export const realFetch: FetchLike = (input, init) => fetch(input, init);

const realAdapters: RealAdapters = {
  openDb: () => openRealCapacitorDb({ name: DATABASE_NAME }),
  closeDb: () => closeRealCapacitorDb(DATABASE_NAME),
  openStore: () => createRealSecureStore(),
};

/**
 * The real adapters behind one call. Rejects with `SchemaTooNewError` when the stored
 * database was written by a newer app; the caller shows the blocking screen for that.
 * When the secure store cannot be opened the database is closed again before the error is rethrown,
 * so a failed launch leaves no connection open.
 */
export async function composeReal(adapters: RealAdapters = realAdapters): Promise<AppServices> {
  const db = await adapters.openDb();
  let store: SecureStore;
  try {
    store = await adapters.openStore();
  } catch (err) {
    await adapters.closeDb().catch(() => undefined);
    throw err;
  }
  return composeWith({
    db,
    files: createRealFiles(),
    store,
    fetch: realFetch,
    authSession: createCapacitorAuthSession(),
    clock: systemClock,
    platform: toClientPlatform(Capacitor.getPlatform()),
    appVersion: __APP_VERSION__,
    closeDb: adapters.closeDb,
  });
}
