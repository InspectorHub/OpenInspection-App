import { useId, useMemo, useState } from 'react';
import type { ImportOutcome } from '../../offline/import-package';
import { Button, Notice } from '../kit';
import { buildResult, type ResultGroup } from './result-model';

export interface ImportResultProps {
  outcome: ImportOutcome;
  /** The address the file carried for some inspections (already cleaned). Empty for a file from before labels. */
  labels: ReadonlyMap<string, string>;
  /** A line about the last save (done, or failed). */
  saveNote: { tone: 'info' | 'bad'; text: string } | null;
  saving: boolean;
  onSave(ids: readonly string[]): void;
  /** Sends the person to the sign-in screen. Without it the page offers "Try again" after a sign-in stop, as it always did. */
  onSignInAgain?: (() => void) | undefined;
  onAgain(): void;
  onAnother(): void;
  onDone(): void;
}

function Group({ group, showSave, saving, onSave }: { group: ResultGroup; showSave: boolean; saving: boolean; onSave(ids: readonly string[]): void }) {
  const count = group.rows.length;
  return (
    <section className="flex flex-col gap-2 border-t border-ih-border pt-4" data-testid={`import-group-${group.key}`}>
      <h3 className="text-base font-semibold text-ih-fg-1">{group.heading}</h3>
      <p className="text-base leading-relaxed text-ih-fg-2">{group.action}</p>
      <ul className="divide-y divide-ih-border rounded-ih-card border border-ih-border">
        {group.rows.map((row) => (
          <li key={row.id} className="break-all px-3 py-3 text-base font-semibold text-ih-fg-1" data-testid="import-row">
            {row.name}
          </li>
        ))}
      </ul>
      {showSave && (
        <Button variant="quiet" disabled={saving} onClick={() => onSave(group.rows.map((r) => r.id))}>
          {count === 1 ? 'Save this one' : `Save these ${String(count)}`}
        </Button>
      )}
    </section>
  );
}

/**
 * The outcome of an import, for someone tired on a phone: one sentence on what happened (the heading), what it means for their data,
 * one main thing to do, and then the inspections that need a look, grouped by what happened to them. What a person does not need to
 * act (server answers, counts, internal reasons) is behind "Details" and not on the page until it is opened. What to say is decided in
 * `result-model.ts`; this file only lays it out.
 */
export function ImportResult({ outcome, labels, saveNote, saving, onSave, onSignInAgain, onAgain, onAnother, onDone }: ImportResultProps) {
  const model = useMemo(() => buildResult(outcome, labels, onSignInAgain !== undefined), [outcome, labels, onSignInAgain]);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const { primary } = model;
  const saveGroups = model.groups.filter((g) => g.save).length;

  function runPrimary(): void {
    // Only a change of screen, no write, so a second tap in the same frame asks for the same screen and needs no latch.
    if (primary.kind === 'signin') onSignInAgain?.();
    else if (primary.kind === 'retry') onAgain();
    else if (primary.kind === 'save') onSave(primary.ids);
    else onDone();
  }

  return (
    <div className="flex flex-col gap-6" data-testid="import-result">
      <section className="flex flex-col gap-4">
        <h2 className="font-ih-display text-xl font-bold tracking-tight text-ih-fg-1" data-testid="import-headline">
          {model.headline}
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-base leading-relaxed text-ih-fg-2">
          {model.meaning.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        {saveNote !== null && <Notice tone={saveNote.tone}>{saveNote.text}</Notice>}
        <div className="flex flex-col gap-3">
          <Button variant="primary" busy={primary.kind === 'save' && saving} data-testid="import-primary-action" onClick={runPrimary}>
            {primary.label}
          </Button>
          {model.secondary.map((action) => (
            <Button key={action.kind} variant="secondary" onClick={action.kind === 'another' ? onAnother : onDone}>
              {action.label}
            </Button>
          ))}
        </div>
      </section>

      {model.attention !== null && (
        <section className="flex flex-col gap-2 border-t border-ih-border pt-4" data-testid="import-attention">
          <h3 className="text-base font-semibold text-ih-fg-1">{model.attention.heading}</h3>
          <p className="text-base leading-relaxed text-ih-fg-2">{model.attention.intro}</p>
          <ul className="divide-y divide-ih-border rounded-ih-card border border-ih-border">
            {model.attention.rows.map((row, index) => (
              <li key={`${row}-${String(index)}`} className="break-all px-3 py-3 text-base text-ih-fg-1">
                {row}
              </li>
            ))}
          </ul>
        </section>
      )}

      {model.groups.map((group) => (
        <Group key={group.key} group={group} showSave={group.save && !(primary.kind === 'save' && saveGroups === 1)} saving={saving} onSave={onSave} />
      ))}

      <section className="flex flex-col gap-2 border-t border-ih-border pt-4">
        <Button variant="quiet" aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen((value) => !value)}>
          Details
        </Button>
        {open && (
          <ul id={detailsId} className="flex flex-col gap-1 font-ih-mono text-sm text-ih-fg-2" data-testid="import-details">
            {model.details.map((line, index) => (
              <li key={`${line}-${String(index)}`} className="break-all">
                {line}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
