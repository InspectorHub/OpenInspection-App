import { useEffect, useState } from 'react';
import type { Network } from '../../platform/network';

/**
 * Whether the device has a network link, or null until that is known. Link state only: online does not mean the server
 * can be reached. With a network port it uses that; without one it uses the page's own online and offline events.
 */
export function useOnline(network?: Pick<Network, 'online' | 'onChange'>): boolean | null {
  const [online, setOnline] = useState<boolean | null>(network === undefined && typeof navigator !== 'undefined' ? navigator.onLine : null);

  useEffect(() => {
    let live = true;
    if (network === undefined) {
      const up = (): void => setOnline(true);
      const down = (): void => setOnline(false);
      setOnline(navigator.onLine);
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      return () => {
        window.removeEventListener('online', up);
        window.removeEventListener('offline', down);
      };
    }
    network.online().then(
      (value) => {
        if (live) setOnline(value);
      },
      () => undefined,
    );
    const off = network.onChange((value) => {
      if (live) setOnline(value);
    });
    return () => {
      live = false;
      off();
    };
  }, [network]);

  return online;
}
