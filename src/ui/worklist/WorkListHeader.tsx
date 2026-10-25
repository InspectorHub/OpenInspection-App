import type { Ref } from 'react';
import { Button } from '../kit';
import { updatedLabel } from './format';

export interface WorkListHeaderProps {
  updatedAt: number | null;
  now: number;
  locale: string | undefined;
  online: boolean | null;
  downloading: boolean;
  /** The sentence about the last download, or null. */
  summary: string | null;
  onDownload(): void;
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
 * The title, how fresh the data is, whether the device is online, and the one button that fetches today's work. The
 * button doubles as the pull-to-refresh: it is always visible and runs the same single flight.
 */
export function WorkListHeader({ updatedAt, now, locale, online, downloading, summary, onDownload, headingRef }: WorkListHeaderProps) {
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
      <p data-testid="refresh-summary" aria-live="polite" className="min-h-5 text-sm leading-relaxed text-ih-fg-2">
        {downloading ? 'Downloading…' : (summary ?? '')}
      </p>
    </header>
  );
}
