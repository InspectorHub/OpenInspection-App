import type { Network } from '../platform/network.ts';

type BrowserWindowLike = Pick<Window, 'addEventListener' | 'removeEventListener'> & { navigator: Pick<Navigator, 'onLine'> };

export function createBrowserNetwork(win: BrowserWindowLike): Network {
  return {
    online: async () => win.navigator.onLine,
    onChange(callback) {
      let active = true;
      const online = (): void => { if (active) callback(true); };
      const offline = (): void => { if (active) callback(false); };
      win.addEventListener('online', online);
      win.addEventListener('offline', offline);
      return () => {
        if (!active) return;
        active = false;
        win.removeEventListener('online', online);
        win.removeEventListener('offline', offline);
      };
    },
  };
}
