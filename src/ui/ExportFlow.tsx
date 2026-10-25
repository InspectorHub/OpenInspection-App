import { useEffect, useMemo, useState } from 'react';
import type { ClientPlatform } from '../app/compose';
import type { TimerPort } from '../collab/timers';
import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import {
  CHECKING_TEXT,
  EXPORT_CONFIRM_LABEL,
  EXPORT_TITLE,
  FAILURE_TEXT,
  INCLUDE_QUARANTINED_LABEL,
  LEFTOVER_NOTICE,
  NOTHING_TO_EXPORT,
  PREPARE_FAILED_TEXT,
  PREPARE_RETRY_LABEL,
  UNCONFIRMED_NOTICE,
  changedText,
  countsText,
  reportIdNotice,
  WORKING_TEXT,
  leftOutNotes,
  responsibilityText,
  summaryText,
} from '../export/copy';
import { createExporter, type ExportFilesPort, type ExportOutcome, type Preflight } from '../export/exporter';
import type { ReconcileGate } from '../export/reconcile-gate';
import { createRealSharer, type Sharer } from '../export/share-package';
import { ConfirmDialog } from './ConfirmDialog';
import { ExportResult } from './ExportResult';
import { Button, Notice } from './kit';
import { useActionLatch } from './latch';

export interface ExportFlowProps {
  /** What an export reads and writes; `AppServices` satisfies it. */
  services: { db: Db; files: ExportFilesPort; clock: Clock; platform: ClientPlatform };
  /** Asks the server which inspections still exist. Absent where no session runs (the lock screen). */
  reconcile?: ReconcileGate | undefined;
  /** Replaces the system share sheet. Tests only. */
  sharer?: Sharer | undefined;
  /** Replaces the timers that schedule the delayed deletion on Android. Tests only. */
  timers?: TimerPort | undefined;
  /** Export only these inspections, and take them even though they are quarantined (the export on a quarantined row). */
  only?: readonly string[] | undefined;
  onClose(): void;
}

/** Used when the preflight itself fails: the export is the way out, so it stays possible and says the list is unconfirmed. */
const UNKNOWN_PREFLIGHT: Preflight = { confirmed: false, included: 0, quarantined: 0, company: null, reportIdUnknown: 0, ids: [] };

/**
 * The export from the first question to the last word: the responsibility sentence and the quarantine choice, the reconcile that
 * runs while the dialog opens, the build and the share sheet, and what the person is told afterwards. Nothing here writes to the
 * database. A device that is locked or needs an update still gets here, because the app never switches the export off.
 */
export function ExportFlow({ services, reconcile, sharer, timers, only, onClose }: ExportFlowProps) {
  const exporter = useMemo(
    () => createExporter({ db: services.db, files: services.files, clock: services.clock, platform: services.platform, sharer: sharer ?? createRealSharer(), timers, reconcile }),
    [services.db, services.files, services.clock, services.platform, sharer, timers, reconcile],
  );
  const [prep, setPrep] = useState<Preflight | null>(null);
  const [include, setInclude] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState<ExportOutcome | null>(null);
  const [prepareFailed, setPrepareFailed] = useState(false);
  const [checks, setChecks] = useState(0);
  const latch = useActionLatch();

  useEffect(() => {
    let current = true;
    setPrepareFailed(false);
    setPrep(null);
    exporter.prepare().then(
      (value) => {
        if (current) setPrep(value);
      },
      () => {
        // The export is the way out, so a failed check leaves it possible: the person is told, and can check again.
        if (current) {
          setPrepareFailed(true);
          setPrep(UNKNOWN_PREFLIGHT);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [exporter, checks]);

  async function run(): Promise<void> {
    if (prep === null) return;
    setError(null);
    setBusy(true);
    let outcome: ExportOutcome;
    try {
      outcome = await exporter.run({ includeQuarantined: only !== undefined || include, only, confirmed: prep.confirmed, expected: only === undefined && !include ? prep.ids : undefined });
    } catch {
      outcome = { kind: 'failed', code: 'build_failed' };
    }
    setBusy(false);
    if (outcome.kind === 'failed') setError(FAILURE_TEXT[outcome.code]);
    else if (outcome.kind === 'busy') setError(FAILURE_TEXT.busy);
    else setFinished(outcome);
  }

  if (finished !== null) {
    if (finished.kind === 'nothing') {
      return (
        <ExportResult title="Nothing to export" onClose={onClose}>
          <Notice tone="info">{NOTHING_TO_EXPORT}</Notice>
          {(finished.changedSincePrepare ?? 0) > 0 && <Notice tone="watch">{changedText(finished.changedSincePrepare ?? 0)}</Notice>}
        </ExportResult>
      );
    }
    if (finished.kind === 'shared' || finished.kind === 'cancelled') {
      return (
        <ExportResult title={finished.kind === 'shared' ? 'Export finished' : 'Export cancelled'} onClose={onClose}>
          <Notice tone="info">{summaryText(finished)}</Notice>
          {finished.unconfirmed && <Notice tone="watch">{UNCONFIRMED_NOTICE}</Notice>}
          {leftOutNotes(finished).map((note) => (
            <Notice key={note} tone="watch">
              {note}
            </Notice>
          ))}
          {finished.leftover && <Notice tone="watch">{LEFTOVER_NOTICE}</Notice>}
        </ExportResult>
      );
    }
  }

  const details = (
    <div className="flex flex-col gap-3">
      {prep === null && (
        <p role="status" className="text-sm leading-relaxed text-ih-fg-2">
          {CHECKING_TEXT}
        </p>
      )}
      {prepareFailed && (
        <div className="flex flex-col gap-2">
          <Notice tone="bad">{PREPARE_FAILED_TEXT}</Notice>
          <Button variant="secondary" disabled={busy} onClick={() => setChecks((n) => n + 1)}>
            {PREPARE_RETRY_LABEL}
          </Button>
        </div>
      )}
      {prep !== null && !prepareFailed && only === undefined && <p className="text-sm leading-relaxed text-ih-fg-2">{countsText(prep.included, prep.quarantined)}</p>}
      {prep !== null && !prep.confirmed && <Notice tone="watch">{UNCONFIRMED_NOTICE}</Notice>}
      {prep !== null && only === undefined && prep.reportIdUnknown > 0 && <Notice tone="watch">{reportIdNotice(prep.reportIdUnknown)}</Notice>}
      {only === undefined && prep !== null && prep.quarantined > 0 && (
        <label className="flex min-h-11 items-center gap-3 text-base text-ih-fg-1">
          <input type="checkbox" className="size-5 shrink-0 accent-ih-primary" checked={include} disabled={busy} onChange={(event) => setInclude(event.target.checked)} />
          {INCLUDE_QUARANTINED_LABEL}
        </label>
      )}
      {busy && (
        <p role="status" className="text-sm leading-relaxed text-ih-fg-2">
          {WORKING_TEXT}
        </p>
      )}
    </div>
  );

  return (
    <ConfirmDialog
      title={EXPORT_TITLE}
      description={responsibilityText(prep?.company ?? null)}
      confirmLabel={EXPORT_CONFIRM_LABEL}
      details={details}
      confirmDisabled={prep === null}
      busy={busy}
      error={error}
      onConfirm={() => void latch(run)}
      onCancel={onClose}
    />
  );
}
