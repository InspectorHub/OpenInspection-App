import type { DesktopBridge } from '../../electron/shared/ipc-contract';
import { createDesktopAuthSession } from './auth-session-desktop';
import { createDesktopDb } from './db-ipc';
import { createDesktopFiles } from './files-ipc';
import { createDesktopKeyValue } from './kv-ipc';
import { createDesktopSharer } from './sharer-desktop';
import { createDesktopSecureStore } from './secure-store-ipc';
import { createDesktopDecodeImage } from './media/decode-heic';
import { systemClock } from '../platform/clock';
import { realFetch, composeWith, type AppServices } from '../app/compose';

/** Composes the shared app services over the Electron preload's narrow, validated bridge. */
export async function composeDesktop(bridge: DesktopBridge): Promise<AppServices> {
  const db = createDesktopDb(bridge);
  const decodeHeic = bridge.media.decodeHeic;
  return composeWith({
    db,
    files: createDesktopFiles(bridge),
    store: createDesktopSecureStore(bridge),
    fetch: realFetch,
    authSession: createDesktopAuthSession(bridge),
    clock: systemClock,
    platform: 'windows',
    appVersion: __APP_VERSION__,
    builtAt: __APP_BUILT_AT__,
    kv: createDesktopKeyValue(bridge),
    openExternal: (url) => bridge.shell.openExternal(url),
    ...(decodeHeic === undefined ? {} : { decodeImage: createDesktopDecodeImage({ media: { decodeHeic } }) }),
    sharer: createDesktopSharer(bridge),
    closeDb: () => bridge.db.close(),
  });
}
