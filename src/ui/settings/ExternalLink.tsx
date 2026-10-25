import { useState } from 'react';
import type { AppServices } from '../../app/compose';
import { httpsHref } from '../../platform/https-href';
import { Notice } from '../kit';
import { useActionLatch } from '../latch';

export const LINK_FAILED = 'The link could not be opened. Try again.';

export interface ExternalLinkProps {
  services: Pick<AppServices, 'openExternal'>;
  /** The address to open. Checked here, at the moment of the tap, whatever put it on the screen: only https passes. */
  url: string | null;
  label: string;
  /** What a screen reader says in place of the label, when the label alone leaves out where it goes. Ignored with `showHost`. */
  accessibleName?: string;
  /**
   * Names the host the page is on, in the accessible name and on a visible second line. For an address the server chose: a label
   * such as "Delete account" is the server's to put on any https page, so the person is shown where the tap will go.
   */
  showHost?: boolean;
}

/**
 * A row that opens an https page in the system browser (a Custom Tab on Android) when the person taps it. Nothing opens by itself,
 * and an address that is not https is refused before it reaches the browser. A page cannot be reached with a script, a file or
 * an app link through this. It has no padding of its own, so its text lines up with the text around it.
 */
export function ExternalLink({ services, url, label, accessibleName, showHost = false }: ExternalLinkProps) {
  const [failed, setFailed] = useState(false);
  const latch = useActionLatch();
  const href = httpsHref(url);
  const host = showHost && href !== null ? new URL(href).host : null;

  async function open(): Promise<void> {
    setFailed(false);
    const checked = httpsHref(url);
    if (checked === null) {
      setFailed(true);
      return;
    }
    try {
      await services.openExternal(checked);
    } catch {
      setFailed(true);
    }
  }

  const name = host === null ? accessibleName : `${label}, opens ${host} in your browser`;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-label={name}
        className="inline-flex min-h-11 flex-col items-start justify-center text-start text-base font-semibold text-ih-primary-text focus-visible:outline-none focus-visible:shadow-ih-focus"
        onClick={() => void latch(open)}
      >
        <span>{label}</span>
        {host !== null && <span className="text-sm font-normal text-ih-fg-3">{`Opens ${host} in your browser`}</span>}
      </button>
      {failed && <Notice tone="bad">{LINK_FAILED}</Notice>}
    </div>
  );
}
