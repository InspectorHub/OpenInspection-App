import { Capacitor } from '@capacitor/core';
import { createCapacitorAuthSession, type AuthSession } from '../auth/auth-session';
import { createHttp, type FetchLike, type Http } from '../auth/http';
import { createLoginFlow, type LoginFlow } from '../auth/pkce-login';
import { createRegistrar, type Registrar } from '../auth/registration';
import { fetchCompat, loadClientId } from '../auth/server-config';
import { createTokenManager, type TokenManager } from '../auth/tokens';
import { systemClock, type Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { closeRealCapacitorDb, openRealCapacitorDb } from '../platform/db-capacitor';
import { createRealFiles, type Files } from '../platform/files';
import { createMemoryKeyValue, createPreferencesKeyValue, type KeyValue } from '../platform/kv';
import { createRealSecureStore, type SecureStore } from '../platform/secure-store';
import { recordRefreshed, recordVerified, setRevoked } from '../offline/lock-state';
import { Browser } from '@capacitor/browser';
import { createRealNotificationPermission, type NotificationPermissionPort } from '../platform/notifications';
import { createClientState, type ClientStateController } from './client-state';
import { createNotificationAsk, type NotificationAsk } from './notification-ask';

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
  /** The UTC ISO instant this build was made, or null when unknown. What the iOS test-build expiry warning counts from. */
  builtAt: string | null;
  /** What the server has asked of this app version and whether the server is too old; fed by every response and by `refreshCompat`. */
  clientState: ClientStateController;
  /**
   * Reads `/api/client/compat` of `origin` into `clientState`. Never rejects: an answer that does not come (offline, a timeout, a page
   * that is not the server's) changes no fact. A call made while one is in flight shares it.
   */
  refreshCompat(origin: string, options?: { timeoutMs?: number }): Promise<void>;
  /** Non-secret app state kept across launches (dismissed notices, the notification question). */
  kv: KeyValue;
  /** The system's notification permission (Android only; `unsupported` elsewhere). */
  notifications: NotificationPermissionPort;
  /** When to explain the notification permission and the memory of the answer. */
  notificationAsk: NotificationAsk;
  /** Hands an https address to the system browser. Callers check the address first (`httpsHref`); rejects when it cannot be opened. */
  openExternal(url: string): Promise<void>;
  /**
   * Calls the listener after the server accepted this device (a token refresh or a session check) and the verification was
   * recorded. For flows that should look again once the grant is known to be good. Returns the unsubscribe function.
   */
  onTokenVerified(listener: () => void): () => void;
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
  /** Non-secret app state (the dismissed update banner). Defaults to an in-memory store. */
  kv?: KeyValue;
  /** The notification permission. Defaults to one that reports `unsupported`. */
  notifications?: NotificationPermissionPort;
  builtAt?: string;
  openExternal?: (url: string) => Promise<void>;
  closeDb?: () => Promise<void>;
}

const UNSUPPORTED_NOTIFICATIONS: NotificationPermissionPort = {
  check: () => Promise.resolve('unsupported'),
  request: () => Promise.resolve('unsupported'),
};

/** The wiring, with every adapter supplied. Tests pass fakes; `composeReal` passes the device's. */
export function composeWith(parts: ComposeParts): AppServices {
  const { db, files, store, clock, platform, appVersion } = parts;
  const kv = parts.kv ?? createMemoryKeyValue();
  const notifications = parts.notifications ?? UNSUPPORTED_NOTIFICATIONS;
  const clientState = createClientState({ kv, appVersion });
  const http = createHttp({
    fetch: parts.fetch,
    defaultHeaders: { 'X-Client-Platform': platform, 'X-Client-Version': appVersion },
    onUpgrade: (value, origin) => clientState.noteUpgrade(origin, value),
  });
  const compatInFlight = new Map<string, Promise<void>>();
  const refreshCompat = (origin: string, options: { timeoutMs?: number } = {}): Promise<void> => {
    const held = compatInFlight.get(origin);
    if (held) return held;
    const run = fetchCompat(http, origin, platform, options).then(
      (compat) => clientState.applyCompat(origin, compat),
      () => clientState.noteCompatAttempt(origin),
    );
    const done = run.finally(() => compatInFlight.delete(origin));
    compatInFlight.set(origin, done);
    return done;
  };
  const registrar = createRegistrar({ http, db });
  const verifiedListeners = new Set<() => void>();
  const tokens = createTokenManager({
    http,
    store,
    clock,
    getClientId: (origin) => loadClientId(db, origin),
    onVerified: async (event) => {
      await (event.sessionConfirmed ? recordVerified(db, event.at, event.offlineMaxDays, event.serverDateMs, event.serverNowMs) : recordRefreshed(db, event.at));
      for (const listener of [...verifiedListeners]) {
        try {
          listener();
        } catch {
          // A failing listener must not change what the auth layer does.
        }
      }
    },
    onRevoked: () => setRevoked(db),
  });
  const flow = createLoginFlow({ http, db, registrar, tokens, authSession: parts.authSession, clock });
  const onTokenVerified = (listener: () => void): (() => void) => {
    verifiedListeners.add(listener);
    return () => {
      verifiedListeners.delete(listener);
    };
  };
  return {
    db,
    files,
    http,
    registrar,
    tokens,
    flow,
    clock,
    platform,
    appVersion,
    builtAt: parts.builtAt ?? null,
    clientState,
    kv,
    notifications,
    notificationAsk: createNotificationAsk({ kv, permission: notifications }),
    refreshCompat,
    openExternal: parts.openExternal ?? (() => Promise.reject(new Error('This build cannot open links'))),
    onTokenVerified,
    close: parts.closeDb ?? (() => Promise.resolve()),
  };
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
 * database was written by a newer app, and with `SchemaDriftError` when a development device still carries an
 * earlier draft of version 1; the caller shows a blocking screen for either.
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
    builtAt: __APP_BUILT_AT__,
    kv: createPreferencesKeyValue(),
    notifications: createRealNotificationPermission(toClientPlatform(Capacitor.getPlatform())),
    openExternal: (url) => Browser.open({ url }),
    closeDb: adapters.closeDb,
  });
}
