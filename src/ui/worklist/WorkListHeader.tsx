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
  /** Opens Settings. Without it the header offers none. */
  onSettings?: (() => void) | undefined;
  /** The Settings button, so focus can return to it when Settings closes. */
  settingsRef?: Ref<HTMLButtonElement> | undefined;
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
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function WorkListHeader({ updatedAt, now, locale, online, downloading, summary, onDownload, onExport, headingRef, onSettings, settingsRef }: WorkListHeaderProps) {
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 ref={headingRef} tabIndex={-1} className="font-ih-display text-2xl font-bold tracking-tight text-ih-fg-1 focus-visible:outline-none">
            Work list
          </h1>
          <p className="text-sm text-ih-fg-3">{updatedLabel(updatedAt, now, locale)}</p>
        </div>
        <div className="flex items-center gap-3">
          <ConnectionChip online={online} />
          {onSettings !== undefined && (
            <button
              ref={settingsRef}
              type="button"
              onClick={onSettings}
              className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-ih-button border border-ih-border-strong bg-ih-bg-card px-3 text-base font-semibold text-ih-fg-1 hover:bg-ih-bg-muted focus-visible:outline-none focus-visible:shadow-ih-focus"
            >
              <GearIcon />
              Settings
            </button>
          )}
        </div>
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
