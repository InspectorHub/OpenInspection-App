import { useState } from 'react';
import { httpsHref } from '../platform/https-href';
import { useActionLatch } from './latch';

export interface UpdateLink {
  /** The normalised https address, or null when the server's address cannot be used. Nothing opens without it. */
  href: string | null;
  /** True after an attempt to open the address failed; cleared by the next attempt. */
  failed: boolean;
  /** Opens the address. Only ever called from a tap. A second call while the first is running is dropped. */
  open(): void;
}

/**
 * The update address is the server's text: it is checked again here, at the moment it is used, with the same https-only rule as
 * every other link the app opens (`httpsHref`), and it is opened only on the person's tap.
 */
export function useUpdateLink(downloadUrl: string | null, openExternal: (url: string) => Promise<void> | void): UpdateLink {
  const href = httpsHref(downloadUrl);
  const [failed, setFailed] = useState(false);
  const latch = useActionLatch();
  return {
    href,
    failed,
    open: () => {
      if (href === null) return;
      void latch(async () => {
        setFailed(false);
        try {
          await openExternal(href);
        } catch {
          setFailed(true);
        }
      });
    },
  };
}
