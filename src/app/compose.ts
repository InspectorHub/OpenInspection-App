import { Capacitor } from '@capacitor/core';
import { createCapacitorAuthSession, type AuthSession } from '../auth/auth-session';
import { createHttp, type FetchLike, type Http } from '../auth/http';
import { createLoginFlow, type LoginFlow } from '../auth/pkce-login';
import { createRegistrar, type Registrar } from '../auth/registration';
import { loadClientId } from '../auth/server-config';
import { createTokenManager, type TokenManager } from '../auth/tokens';
import { systemClock, type Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import { openRealCapacitorDb } from '../platform/db-capacitor';
import { createRealSecureStore, type SecureStore } from '../platform/secure-store';

export type ClientPlatform = 'android' | 'ios';

export const DATABASE_NAME = 'inspectorhub';

/** Everything the screens use. Built once per launch, by `composeReal` or, in tests, by `composeWith`. */
export interface AppServices {
  db: Db;
  http: Http;
  registrar: Registrar;
  tokens: TokenManager;
  flow: LoginFlow;
  clock: Clock;
  platform: ClientPlatform;
  appVersion: string;
}

export interface ComposeParts {
  db: Db;
  store: SecureStore;
  fetch: FetchLike;
  authSession: AuthSession;
  clock: Clock;
  platform: ClientPlatform;
  appVersion: string;
}

/** The wiring, with every adapter supplied. Tests pass fakes; `composeReal` passes the device's. */
export function composeWith(parts: ComposeParts): AppServices {
  const { db, store, clock, platform, appVersion } = parts;
  const http = createHttp({
    fetch: parts.fetch,
    defaultHeaders: { 'X-Client-Platform': platform, 'X-Client-Version': appVersion },
  });
  const registrar = createRegistrar({ http, db });
  const tokens = createTokenManager({ http, store, clock, getClientId: (origin) => loadClientId(db, origin) });
  const flow = createLoginFlow({ http, db, registrar, tokens, authSession: parts.authSession, clock });
  return { db, http, registrar, tokens, flow, clock, platform, appVersion };
}

/** Anything that is not iOS reports as Android, which includes the browser used for development. */
export function toClientPlatform(capacitorPlatform: string): ClientPlatform {
  return capacitorPlatform === 'ios' ? 'ios' : 'android';
}

/**
 * The real adapters behind one call. Rejects with `SchemaTooNewError` when the stored
 * database was written by a newer app; the caller shows the blocking screen for that.
 */
export async function composeReal(): Promise<AppServices> {
  const db = await openRealCapacitorDb({ name: DATABASE_NAME });
  const store = await createRealSecureStore();
  return composeWith({
    db,
    store,
    fetch: (input, init) => fetch(input, init),
    authSession: createCapacitorAuthSession(),
    clock: systemClock,
    platform: toClientPlatform(Capacitor.getPlatform()),
    appVersion: __APP_VERSION__,
  });
}
