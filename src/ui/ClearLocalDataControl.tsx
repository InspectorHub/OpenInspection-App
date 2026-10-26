import { useEffect, useRef, useState } from 'react';
import type { AppServices } from '../app/compose';
import { countAtRisk, type AtRisk } from '../offline/at-risk';
import { clearLocalData } from '../offline/clear-local-data';
import { ConfirmDialog } from './ConfirmDialog';
import { ExportResult } from './ExportResult';
import { Button, Notice } from './kit';
import { useActionLatch } from './latch';

export interface ClearLocalDataControlProps {
  services: Pick<AppServices, 'db' | 'files' | 'tokens' | 'clock'>;
  origin: string;
  /** Local data was cleared; the person can sign in again to the same server. */
  onCleared(): void;
  /**
   * True from the moment the data starts to be removed until the person leaves for sign-in, false again when the clear failed.
   * The app stops its lock checks while it is true: a device whose verification marks were just removed is not "expired".
   */
  onWiping?(wiping: boolean): void;
}

const FIRST_DESCRIPTION = 'This permanently removes the inspections, photos and changes stored on this device. This cannot be undone.';
const SECOND_DESCRIPTION = 'These items exist only on this device. Once removed they cannot be recovered. Export them first if you may need them.';
export const CLEAR_FAILED = 'Local data could not be cleared. Try again.';
export const COUNT_UNKNOWN = 'The app could not count what has not been uploaded. Treat everything on this device as not uploaded.';

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** The lines of what has not reached the server, one per kind that is not zero. */
export function atRiskLines(risk: AtRisk): string[] {
  const lines: string[] = [];
  if (risk.waiting > 0) lines.push(`${plural(risk.waiting, 'photo, clip or change', 'photos, clips and changes')} not uploaded`);
  if (risk.orphaned > 0) lines.push(`${plural(risk.orphaned, 'change', 'changes')} that can no longer be sent`);
  if (risk.createdHere > 0) lines.push(`${plural(risk.createdHere, 'inspection', 'inspections')} created on this device and not yet on the server`);
  if (risk.unsyncedEdits > 0) lines.push(`${plural(risk.unsyncedEdits, 'inspection', 'inspections')} with edits not yet on the server`);
  return lines;
}

/** What one count found for one opening of the dialog. A null risk means the count failed. */
interface Counted {
  opening: number;
  risk: AtRisk | null;
}

/**
 * Clear local data, behind a question that says what will be lost. When something has not been uploaded the question is asked a
 * second time with the count in the title: one tap on the first dialog never removes unsent work. The count is made again right
 * before a single-step clear, so work that arrived while the dialog was open sends the person to the second step instead of being
 * removed. Signing out follows the clear (the sign-in belongs to the data that was removed). Never `window.confirm`.
 */
export function ClearLocalDataControl({ services, origin, onCleared, onWiping }: ClearLocalDataControlProps) {
  const [step, setStep] = useState<'closed' | 'first' | 'second'>('closed');
  const [opening, setOpening] = useState(0);
  const [counted, setCounted] = useState<Counted | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftover, setLeftover] = useState<number | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const latch = useActionLatch();

  useEffect(() => {
    if (step !== 'first') return undefined;
    let current = true;
    countAtRisk(services.db).then(
      (risk) => {
        if (current) setCounted({ opening, risk });
      },
      () => {
        if (current) setCounted({ opening, risk: null });
      },
    );
    return () => {
      current = false;
    };
  }, [step, opening, services.db]);

  // Derived, so the first frame of a new opening already counts and an answer from an earlier opening is never taken for this one.
  const answer = counted !== null && counted.opening === opening ? counted : null;
  const counting = step !== 'closed' && answer === null;
  const risk = answer?.risk ?? null;
  const countFailed = answer !== null && answer.risk === null;

  async function clear(from: 'first' | 'second'): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      if (from === 'first') {
        let fresh: AtRisk | null = null;
        try {
          fresh = await countAtRisk(services.db);
        } catch {
          fresh = null;
        }
        if (fresh === null || fresh.total > 0) {
          setCounted({ opening, risk: fresh });
          setStep('second');
          setBusy(false);
          return;
        }
      }
      onWiping?.(true);
      const result = await clearLocalData(services.db, services.files, services.clock.now());
      await services.tokens.signOut(origin).catch(() => undefined);
      setStep('closed');
      setBusy(false);
      if (result.filesFailed.length > 0) setLeftover(result.filesFailed.length);
      else onCleared();
    } catch {
      onWiping?.(false);
      setError(CLEAR_FAILED);
      setBusy(false);
    }
  }

  function open(): void {
    setOpening((n) => n + 1);
    setStep('first');
  }

  function close(): void {
    setStep('closed');
    setError(null);
    trigger.current?.focus();
  }

  const unsent = countFailed || (risk !== null && risk.total > 0);
  const lines = risk === null ? [] : atRiskLines(risk);

  const details = (
    <div className="flex flex-col gap-2">
      {counting && (
        <p role="status" className="text-sm leading-relaxed text-ih-fg-2">
          Counting what has not been uploaded…
        </p>
      )}
      {countFailed && <Notice tone="watch">{COUNT_UNKNOWN}</Notice>}
      {risk !== null && lines.length === 0 && <p className="text-sm leading-relaxed text-ih-fg-2">Everything on this device has been uploaded.</p>}
      {lines.length > 0 && (
        <ul data-testid="at-risk" className="list-disc pl-5 text-base font-semibold text-ih-fg-1">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );

  const total = risk?.total ?? 0;
  return (
    <>
      <Button ref={trigger} variant="secondary" onClick={open}>
        Clear local data
      </Button>
      {step === 'first' && (
        <ConfirmDialog
          title="Clear local data?"
          description={FIRST_DESCRIPTION}
          details={details}
          confirmLabel={unsent ? 'Continue' : 'Clear local data'}
          destructive={!unsent}
          confirmDisabled={counting}
          busy={busy}
          error={error}
          onConfirm={() => {
            if (unsent) setStep('second');
            else void latch(() => clear('first'));
          }}
          onCancel={close}
        />
      )}
      {step === 'second' && (
        <ConfirmDialog
          title={countFailed ? 'Delete data that may not be uploaded?' : `Delete ${plural(total, 'item', 'items')} that ${total === 1 ? 'is' : 'are'} not uploaded?`}
          description={SECOND_DESCRIPTION}
          details={details}
          confirmLabel="Delete everything"
          cancelLabel="Keep my data"
          destructive
          busy={busy}
          error={error}
          onConfirm={() => void latch(() => clear('second'))}
          onCancel={close}
        />
      )}
      {leftover !== null && (
        <ExportResult title="Local data cleared" onClose={onCleared}>
          <Notice tone="watch">{`${plural(leftover, 'photo file', 'photo files')} could not be removed from this device's storage. The records are gone, but ${leftover === 1 ? 'the file' : 'the files'} may remain until the app is uninstalled.`}</Notice>
        </ExportResult>
      )}
    </>
  );
}
