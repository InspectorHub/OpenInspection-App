import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { OfflineStack } from '../app/offline-stack';
import type { RestoreBackupNotice } from '../collab/connector';
import { FORMAT_LOCALE } from '../platform/format-locale';
import { ConfirmDialog } from './ConfirmDialog';
import { Button, Notice } from './kit';

/**
 * The notice for a copy a version restore set aside instead of merging (`src/collab/restore-backup.ts`).
 *
 * It is a blocking dialog, not a toast: the restore replaced what the person sees, and the copy is only safe while
 * they know it is there. One tap restores it ("Restore my offline copy"); "Not now" only puts the dialog away for
 * this editor session — the banner below stays, with a Review button, until the person restores or discards the copy.
 * Discarding is a separate, deliberate step with its own confirm, because it deletes the only copy of that work.
 * The notice survives an app restart (the stack loads the saved copies at start), so it appears again on the next
 * open of the inspection.
 */

const DIALOG_TITLE = "Your offline copy couldn't be merged";
const BANNER_TITLE = "Your offline copy couldn't be merged.";

function formatTime(atMs: number): string {
  return new Intl.DateTimeFormat(FORMAT_LOCALE, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(atMs));
}

function failureMessage(reason: 'missing' | 'not-stored' | 'blocked' | 'failed'): string {
  switch (reason) {
    case 'missing':
      return 'The saved copy is no longer on this device.';
    case 'not-stored':
      return 'The copy could not be put back yet. Try again.';
    case 'blocked':
      return 'This inspection is being removed from this device and cannot be used right now.';
    default:
      return 'The copy could not be restored. Try again.';
  }
}

export interface RestoreBackupNoticeProps {
  stack: OfflineStack;
  inspectionId: string;
}

export function RestoreBackupNotice({ stack, inspectionId }: RestoreBackupNoticeProps) {
  const notices = useSyncExternalStore(stack.restoreNotices.subscribe, stack.restoreNotices.get);
  const notice: RestoreBackupNotice | null = notices.find((n) => n.inspectionId === inspectionId) ?? null;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discardError, setDiscardError] = useState<string | null>(null);
  /** The copy the dialog has already been opened for: a new copy (a later restore) opens it again. */
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    if (notice === null) {
      shownFor.current = null;
      return;
    }
    const key = `${notice.inspectionId}:${String(notice.backedUpAt)}`;
    if (shownFor.current !== key) {
      shownFor.current = key;
      setDialogOpen(true);
    }
  }, [notice]);

  if (notice === null) return null;
  const time = formatTime(notice.backedUpAt);

  const restore = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void stack.restoreBackup(inspectionId).then(
      (outcome) => {
        setBusy(false);
        if (outcome.ok) setDialogOpen(false);
        else setError(failureMessage(outcome.reason));
      },
      () => {
        setBusy(false);
        setError('The copy could not be restored. Try again.');
      },
    );
  };

  const discard = (): void => {
    if (busy) return;
    setBusy(true);
    setDiscardError(null);
    void stack.discardRestoreBackup(inspectionId).then(
      (deleted) => {
        setBusy(false);
        if (deleted) setConfirmingDiscard(false);
        else setDiscardError('The saved copy could not be deleted. Try again.');
      },
      () => {
        setBusy(false);
        setDiscardError('The saved copy could not be deleted. Try again.');
      },
    );
  };

  return (
    <>
      {!dialogOpen && (
        <div className="px-4 pt-[max(0.5rem,var(--safe-area-inset-top,env(safe-area-inset-top,0px)))]">
          <Notice tone="watch">
            <span>
              {BANNER_TITLE} Your offline copy from {time} is saved on this device.
            </span>
            <span className="mt-2 flex flex-col gap-2">
              <Button variant="secondary" onClick={() => setDialogOpen(true)}>
                Review
              </Button>
              <Button variant="quiet" onClick={() => setConfirmingDiscard(true)}>
                Discard saved copy
              </Button>
            </span>
          </Notice>
        </div>
      )}
      {dialogOpen && (
        <ConfirmDialog
          title={DIALOG_TITLE}
          description={`The server restored an earlier version of this inspection, so the copy on this device from ${time} was set aside instead of being merged. Restoring it brings your ratings, notes and defects back into this inspection.`}
          confirmLabel="Restore my offline copy"
          cancelLabel="Not now"
          busy={busy}
          error={error}
          onConfirm={restore}
          onCancel={() => {
            if (!busy) setDialogOpen(false);
          }}
        />
      )}
      {confirmingDiscard && (
        <ConfirmDialog
          title="Discard the saved copy?"
          description="The copy of your offline work saved on this device will be deleted. The restored version stays as it is."
          confirmLabel="Discard saved copy"
          destructive
          busy={busy}
          error={discardError}
          onConfirm={discard}
          onCancel={() => {
            if (!busy) setConfirmingDiscard(false);
          }}
        />
      )}
    </>
  );
}
