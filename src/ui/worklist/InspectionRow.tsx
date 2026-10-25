import { Button } from '../kit';
import { Badge } from './Badge';
import { REFRESH_ERROR_TEXT, plural } from './copy';
import { shortTitle, whenLabel } from './format';
import type { WorkListRow } from './model';
import { ExportBlock, RowQuarantineBanner } from './QuarantineBanner';

export const SUSPICIOUS_REMOVE_LABEL = 'No longer on the server — remove from this device';
export const REMOVE_LABEL = 'Remove from this device';

export interface InspectionRowProps {
  row: WorkListRow;
  locale: string | undefined;
  company: string | null;
  onOpen(row: WorkListRow): void;
  onTogglePin(row: WorkListRow): void;
  onRemove(row: WorkListRow): void;
  /** When absent, no export button and no export wording is rendered. */
  onExport: ((id: string) => void) | undefined;
}

/** The colour of the card's left edge: the worst thing true of the inspection, so a list can be scanned by edge alone. */
function edgeOf(row: WorkListRow): string {
  if (row.blocked !== 'none') return 'border-l-ih-watch';
  if (row.needAttention > 0) return 'border-l-ih-bad';
  if (row.waiting > 0 || row.lastError !== null || row.createdLocally) return 'border-l-ih-watch';
  return row.downloaded ? 'border-l-ih-ok' : 'border-l-ih-border-strong';
}

export function InspectionRow({ row, locale, company, onOpen, onTogglePin, onRemove, onExport }: InspectionRowProps) {
  const title = shortTitle(row);
  const inert = row.blocked !== 'none';
  const when = whenLabel(row.scheduledAt, row.group, locale);
  const quarantined = row.blocked === 'quarantined';
  const showCounts = row.blocked === 'none';
  return (
    <li data-testid={`row-${row.id}`} className={`relative flex flex-col gap-3 rounded-ih-card border border-l-4 border-ih-border bg-ih-bg-card p-3 shadow-ih-card ${edgeOf(row)}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <h3 className="font-ih-display text-base font-semibold leading-snug text-ih-fg-1">
            <button
              type="button"
              aria-label={`Open ${title}`}
              aria-disabled={inert ? true : undefined}
              onClick={() => {
                if (!inert) onOpen(row);
              }}
              className={`min-h-11 w-full break-words [overflow-wrap:anywhere] rounded-ih-button py-2 text-left focus-visible:outline-none focus-visible:shadow-ih-focus after:absolute after:inset-0 after:content-[''] ${inert ? 'cursor-default' : ''}`}
            >
              {title}
            </button>
          </h3>
          {when !== null && <p className="text-sm text-ih-fg-3">{when}</p>}
        </div>
        {(row.canPin || row.canUnpin) && (
          <button
            type="button"
            aria-label={`${row.pinned ? 'Unpin' : 'Pin'} ${title}`}
            onClick={() => onTogglePin(row)}
            className={`relative z-10 min-h-11 min-w-11 rounded-ih-button border px-3 text-sm font-semibold focus-visible:outline-none focus-visible:shadow-ih-focus ${row.pinned ? 'border-ih-primary bg-ih-primary-tint text-ih-primary-text' : 'border-ih-border-strong bg-ih-bg-card text-ih-fg-2'}`}
          >
            Pin
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {quarantined && <Badge tone="watch">Quarantined</Badge>}
        {row.blocked === 'purging' && <Badge tone="neutral">Removing…</Badge>}
        {row.downloaded ? <Badge tone="ok">Downloaded</Badge> : <Badge tone="neutral">Not downloaded yet</Badge>}
        {row.pinned && <Badge tone="info">Pinned</Badge>}
        {showCounts && row.waiting > 0 && <Badge tone="watch">{`Waiting to upload: ${String(row.waiting)}`}</Badge>}
        {showCounts && row.needAttention > 0 && <Badge tone="bad">{`${String(row.needAttention)} need attention`}</Badge>}
        {row.createdLocally && <Badge tone="info">Created on this device, not yet sent</Badge>}
        {row.lastError !== null && <Badge tone="watch">{REFRESH_ERROR_TEXT[row.lastError]}</Badge>}
      </div>

      {row.orphaned > 0 && (
        <p className="text-sm text-ih-fg-2">{`${plural(row.orphaned, 'queued change is', 'queued changes are')} on hold because this inspection is no longer on your list`}</p>
      )}
      {quarantined && row.waiting > 0 && (
        <p className="text-sm text-ih-fg-2">{`${plural(row.waiting, 'photo or clip is', 'photos and clips are')} not being uploaded because this inspection is no longer on your list`}</p>
      )}
      {quarantined && <RowQuarantineBanner />}
      {row.blocked === 'purging' && <p className="text-sm text-ih-fg-3">Removing from this device…</p>}

      {(row.removable || (quarantined && onExport !== undefined)) && (
        <div className="relative z-10 flex flex-col gap-3">
          {quarantined && onExport !== undefined && <ExportBlock company={company} onExport={() => onExport(row.id)} />}
          {row.removable && (
            <Button variant="secondary" aria-label={row.namedByPlan ? `No longer on the server — remove ${title} from this device` : `Remove ${title} from this device`} onClick={() => onRemove(row)}>
              {row.namedByPlan ? SUSPICIOUS_REMOVE_LABEL : REMOVE_LABEL}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
