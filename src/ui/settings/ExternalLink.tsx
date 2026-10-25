import { useState } from 'react';
import type { AppServices } from '../../app/compose';
import { httpsHref } from '../../platform/https-href';
import { Button, Notice } from '../kit';
import { useActionLatch } from '../latch';

export const LINK_FAILED = 'The link could not be opened. Try again.';

export interface ExternalLinkProps {
  services: Pick<AppServices, 'openExternal'>;
  /** The address to open. Checked here, at the moment of the tap, whatever put it on the screen: only https passes. */
  url: string | null;
  label: string;
  /** What a screen reader says in place of the label, when the label alone leaves out where it goes. */
  accessibleName?: string;
}

/**
 * A row that opens an https page in the system browser (a Custom Tab on Android) when the person taps it. Nothing opens by itself,
 * and an address that is not https is refused before it reaches the browser. A page cannot be reached with a script, a file or
 * an app link through this.
 */
export function ExternalLink({ services, url, label, accessibleName }: ExternalLinkProps) {
  const [failed, setFailed] = useState(false);
  const latch = useActionLatch();

  async function open(): Promise<void> {
    setFailed(false);
    const href = httpsHref(url);
    if (href === null) {
      setFailed(true);
      return;
    }
    try {
      await services.openExternal(href);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="quiet" className="text-start" aria-label={accessibleName} onClick={() => void latch(open)}>
        {label}
      </Button>
      {failed && <Notice tone="bad">{LINK_FAILED}</Notice>}
    </div>
  );
}
