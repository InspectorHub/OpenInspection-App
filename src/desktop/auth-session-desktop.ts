import { createAndroidAuthSession, type AppLike, type AuthSession, type BrowserLike } from '../auth/auth-session.ts';
import type { DesktopBridge } from '../../electron/shared/ipc-contract.ts';

type DesktopAuthBridge = Pick<DesktopBridge, 'auth'>;

export function createDesktopAppLike(bridge: DesktopAuthBridge): AppLike {
  return {
    addListener: async (_event, listener) => {
      const remove = bridge.auth.onCallback((url) => listener({ url }));
      return { remove: async () => { remove(); } };
    },
  };
}

export function createDesktopAuthSession(
  bridge: Pick<DesktopBridge, 'shell' | 'auth'>,
  deps: { timeoutMs?: number } = {},
): AuthSession {
  const browser: BrowserLike = {
    open: ({ url }) => bridge.shell.openExternal(url),
    close: async () => {},
    addListener: async () => ({ remove: async () => {} }),
  };
  return createAndroidAuthSession({ browser, app: createDesktopAppLike(bridge), ...deps });
}
