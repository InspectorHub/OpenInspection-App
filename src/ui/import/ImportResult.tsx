import type { HeldBack } from '@inspectorhub/offline-package';
import type { ImportOutcome } from '../../offline/import-package';
import { Button, Notice } from '../kit';
import { stripBidi } from '../worklist/format';
import {
  AGAIN_LABEL,
  ALL_IMPORTED,
  ALL_SKIPPED,
  ANOTHER_LABEL,
  ATTENTION_HEADING,
  ATTENTION_INTRO,
  DONE_LABEL,
  NONE_IMPORTED,
  RESULT_HEADING,
  saveGroupLabel,
  STOP_TEXT,
  unsentText,
} from './copy';
import { HeldBackList } from './HeldBackList';

export interface ImportResultProps {
  outcome: ImportOutcome;
  /** A line about the last save (done, or failed). */
  saveNote: { tone: 'info' | 'bad'; text: string } | null;
  saving: boolean;
  onSave(ids: readonly string[]): void;
  onAgain(): void;
  onAnother(): void;
  onDone(): void;
}

/**
 * Inspections left behind only because the import was stopped before their part ever went out. A part whose request went out and lost
 * its answer may have been applied, so it is "not confirmed" (and listed with that explanation), never "not sent".
 */
const isUnsent = (h: HeldBack, requested: ReadonlySet<string>): boolean => h.reason === 'gave_up' && h.status === undefined && !requested.has(h.id);

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="min-w-0 rounded-ih-card border border-ih-border p-3">
      <dt className="text-sm font-semibold text-ih-fg-3">{label}</dt>
      <dd className="text-2xl font-bold text-ih-fg-1">{value}</dd>
      <dd className="text-sm text-ih-fg-3">{hint}</dd>
    </div>
  );
}

/**
 * The outcome of an import in four numbers, then the detail behind the last two. Two different things need a look, each with its own
 * list and unit: inspections left behind (counted in inspections, listed with a reason and a way to save them) and queued changes
 * the server refused (counted in changes; their inspection's results and photos still arrived). They are never added together.
 * An import that was stopped says why in one place instead of listing every unsent inspection as a separate failure.
 */
export function ImportResult({ outcome, saveNote, saving, onSave, onAgain, onAnother, onDone }: ImportResultProps) {
  const { report, stopped } = outcome;
  const unsent = stopped === null ? [] : report.heldBack.filter((h) => isUnsent(h, outcome.requested));
  const listed = stopped === null ? report.heldBack : report.heldBack.filter((h) => !isUnsent(h, outcome.requested));
  const nothingChanged = report.imported.length > 0 && report.heldBack.length === 0 && report.applied === 0 && report.skipped > 0 && report.needsAttention.length === 0;
  let banner: { tone: 'info' | 'bad'; text: string } | null = null;
  if (report.heldBack.length > 0) {
    if (report.imported.length === 0 && stopped === null) banner = { tone: 'bad', text: NONE_IMPORTED };
  } else if (nothingChanged) banner = { tone: 'info', text: ALL_SKIPPED };
  else if (report.needsAttention.length === 0) banner = { tone: 'info', text: ALL_IMPORTED };

  return (
    <div className="flex flex-col gap-6" data-testid="import-result">
      <section aria-label={RESULT_HEADING} className="flex flex-col gap-4">
        <h2 className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">{RESULT_HEADING}</h2>
        <dl className="grid grid-cols-2 gap-3">
          <Stat label="Imported" value={report.imported.length} hint="inspections" />
          <Stat label="Skipped" value={report.skipped} hint="changes already applied" />
          <Stat label="Not imported" value={report.heldBack.length} hint="inspections left behind" />
          <Stat label="Refused changes" value={report.needsAttention.length} hint="queued changes the server refused" />
        </dl>
        {stopped !== null && (
          <Notice tone="bad">
            <strong className="block">{STOP_TEXT[stopped].title}</strong>
            {STOP_TEXT[stopped].body}
          </Notice>
        )}
        {banner !== null && <Notice tone={banner.tone}>{banner.text}</Notice>}
        {saveNote !== null && <Notice tone={saveNote.tone}>{saveNote.text}</Notice>}
        <div className="flex flex-col gap-3">
          {report.heldBack.length > 0 && (
            <Button variant="primary" onClick={onAgain}>
              {AGAIN_LABEL}
            </Button>
          )}
          <Button variant="secondary" onClick={onAnother}>
            {ANOTHER_LABEL}
          </Button>
          <Button variant="quiet" onClick={onDone}>
            {DONE_LABEL}
          </Button>
        </div>
      </section>

      {report.needsAttention.length > 0 && (
        <section aria-label={ATTENTION_HEADING} className="flex flex-col gap-3" data-testid="import-attention">
          <div>
            <h2 className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">{ATTENTION_HEADING}</h2>
            <p className="text-sm text-ih-fg-3">{ATTENTION_INTRO}</p>
          </div>
          <ul className="divide-y divide-ih-border rounded-ih-card border border-ih-border">
            {report.needsAttention.map((row) => (
              <li key={row.idempotencyKey} className="px-3 py-3">
                <p className="break-all text-base font-semibold text-ih-fg-1">{`${stripBidi(row.op)} on inspection ${stripBidi(row.inspectionId)}`}</p>
                <p className="text-sm text-ih-fg-3">{`Server answer: ${String(row.status)}${row.reason === undefined ? '' : ` - Reason: ${stripBidi(row.reason)}`}`}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {unsent.length > 0 && (
        <section aria-label="Not sent" className="flex flex-col gap-3" data-testid="import-unsent">
          <p className="text-base text-ih-fg-1">{unsentText(unsent.length)}</p>
          <Button variant="secondary" disabled={saving} onClick={() => onSave(unsent.map((h) => h.id))}>
            {saveGroupLabel(unsent.length)}
          </Button>
        </section>
      )}

      {listed.length > 0 && <HeldBackList rows={listed} onSave={onSave} saving={saving} />}
    </div>
  );
}
