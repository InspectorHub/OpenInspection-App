import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { createCapacitorAuthSession } from '../auth/auth-session-capacitor';
import { createDesktopAuthSession } from '../desktop/auth-session-desktop';
import { getDesktopBridge } from '../desktop/bridge';
import { realSocketFactory } from '../collab/real';
import { createRealSharer } from '../export/share-capacitor';
import type { AppStatePort } from '../offline/lock-monitor';
import { systemClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { closeRealCapacitorDb, openRealCapacitorDb } from '../platform/db-capacitor';
import { createRealFiles } from '../platform/files-capacitor';
import { createPreferencesKeyValue } from '../platform/kv-capacitor';
import { createRealNetwork } from '../platform/network-capacitor';
import { createRealNotificationPermission } from '../platform/notifications-capacitor';
import type { SecureStore } from '../platform/secure-store';
import { createRealSecureStore } from '../platform/secure-store-capacitor';
import { createRealUploaderPlugin } from '../platform/uploader-capacitor';
import { composeWith, realFetch, type AppServices, type ClientPlatform } from './compose';
import { createStackFactory } from './real-stack';
import type { StackFactory } from './use-offline-stack';

export const DATABASE_NAME = 'inspectorhub';

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

const realAdapters: RealAdapters = {
  openDb: () => openRealCapacitorDb({ name: DATABASE_NAME }),
  closeDb: () => closeRealCapacitorDb(DATABASE_NAME),
  openStore: () => createRealSecureStore(),
};

function createPlatformAuthSession() {
  const desktopBridge = typeof window !== 'undefined' && window.oiDesktop ? getDesktopBridge() : null;
  return desktopBridge ? createDesktopAuthSession(desktopBridge) : createCapacitorAuthSession();
}

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
    authSession: createPlatformAuthSession(),
    clock: systemClock,
    platform: toClientPlatform(Capacitor.getPlatform()),
    appVersion: __APP_VERSION__,
    builtAt: __APP_BUILT_AT__,
    kv: createPreferencesKeyValue(),
    notifications: createRealNotificationPermission(toClientPlatform(Capacitor.getPlatform())),
    openExternal: (url) => Browser.open({ url }),
    sharer: createRealSharer(),
    closeDb: adapters.closeDb,
  });
}

/** The Capacitor network and uploader plugins, the page's WebSocket and timers, behind the offline stack. */
export function createRealStackFactory(options: { appState: AppStatePort }): StackFactory {
  return createStackFactory({ network: createRealNetwork(), uploaderPlugin: createRealUploaderPlugin(), socketFactory: realSocketFactory }, options);
}
