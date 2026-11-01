import type { HeldBack } from '@inspectorhub/offline-package';
import { Button } from '../kit';
import { stripBidi } from '../worklist/format';
import { answerText, groupHeldBack, HELD_HEADING, HELD_INTRO, saveGroupLabel } from './copy';

export interface HeldBackListProps {
  rows: readonly HeldBack[];
  /** Saves the listed inspections as a package of their own. The caller guards it against a second tap in the same frame. */
  onSave(ids: readonly string[]): void;
  saving: boolean;
}

/**
 * Inspections an import did not bring in, grouped by why. A refusal of the whole package would otherwise print one paragraph per
 * inspection, so each distinct explanation is written once and the inspections it applies to are listed under it. Every row names
 * its own reason and the status and code of the answer behind it, and can be saved on its own. Nothing here is lost data: the
 * original file is untouched, and a left-behind inspection is still in it.
 */
export function HeldBackList({ rows, onSave, saving }: HeldBackListProps) {
  return (
    <section aria-label={HELD_HEADING} className="flex flex-col gap-4" data-testid="import-held-back">
      <div>
        <h2 className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">{HELD_HEADING}</h2>
        <p className="text-sm text-ih-fg-3">{HELD_INTRO}</p>
      </div>
      {groupHeldBack(rows).map(({ explanation, rows: groupRows }) => (
        <div key={explanation.group} className="flex flex-col gap-2 border-t border-ih-border pt-4" data-testid={`held-back-group-${explanation.group}`}>
          <p className="text-base font-semibold text-ih-fg-1">{explanation.what}</p>
          <p className="text-sm text-ih-fg-2">{explanation.next}</p>
          <ul className="divide-y divide-ih-border rounded-ih-card border border-ih-border">
            {groupRows.map((row) => {
              const answer = answerText(row);
              return (
                <li key={row.id} className="flex flex-col gap-2 px-3 py-3" data-testid="held-back-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="break-all text-base font-semibold text-ih-fg-1">Inspection {stripBidi(row.id)}</span>
                    <span className="rounded-ih-card bg-ih-watch-bg px-2 py-0.5 text-sm text-ih-watch-fg">{explanation.label}</span>
                  </div>
                  <p className="text-sm text-ih-fg-3">
                    {answer === null ? 'No confirmed answer from the server' : `Server answer: ${answer}`}
                    {row.detail !== undefined && row.detail !== 'local_error' ? ` - Server detail: ${stripBidi(row.detail)}` : ''}
                  </p>
                  <Button variant="secondary" disabled={saving} onClick={() => onSave([row.id])}>
                    Save this part
                  </Button>
                </li>
              );
            })}
          </ul>
          {groupRows.length > 1 && (
            <Button variant="quiet" disabled={saving} onClick={() => onSave(groupRows.map((r) => r.id))}>
              {saveGroupLabel(groupRows.length)}
            </Button>
          )}
        </div>
      ))}
    </section>
  );
}
