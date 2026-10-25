import type { Ref } from 'react';
import { Button } from '../kit';
import { updatedLabel } from './format';
import { LiveNote } from './LiveNote';

export interface WorkListHeaderProps {
  updatedAt: number | null;
  now: number;
  locale: string | undefined;
  online: boolean | null;
  downloading: boolean;
  /** The sentence about the last download, or null. */
  summary: string | null;
  onDownload(): void;
  /** Opens the export of everything this device holds. Without it the header offers none. */
  onExport?: (() => void) | undefined;
  headingRef: Ref<HTMLHeadingElement>;
}

function ConnectionChip({ online }: { online: boolean | null }) {
  if (online === null) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-ih-pill px-2 py-1 text-xs font-bold ${online ? 'bg-ih-ok-bg text-ih-ok-fg' : 'bg-ih-bg-muted text-ih-fg-2'}`}>
      <span aria-hidden="true" className={`size-2 rounded-full ${online ? 'bg-ih-ok' : 'bg-ih-fg-4'}`} />
      {online ? 'Online' : 'Offline'}
    </span>
  );
}

/**
 * The title, how fresh the data is, whether the device is online, and the one button that fetches today's work. Pulling the
 * page down does the same thing (`usePullToRefresh`); this always-visible button is the accessible way, and both run the single
 * flight the refresher allows.
 */
export function WorkListHeader({ updatedAt, now, locale, online, downloading, summary, onDownload, onExport, headingRef }: WorkListHeaderProps) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 ref={headingRef} tabIndex={-1} className="font-ih-display text-2xl font-bold tracking-tight text-ih-fg-1 focus-visible:outline-none">
            Work list
          </h1>
          <p className="text-sm text-ih-fg-3">{updatedLabel(updatedAt, now, locale)}</p>
        </div>
        <ConnectionChip online={online} />
      </div>
      <Button busy={downloading} onClick={onDownload}>
        Download today&apos;s work
      </Button>
      {onExport !== undefined && (
        <Button variant="quiet" onClick={onExport}>
          Export unsent data
        </Button>
      )}
      <LiveNote testId="refresh-summary" className="text-sm leading-relaxed text-ih-fg-2" text={downloading ? 'Downloading…' : (summary ?? '')} />
    </header>
  );
}
