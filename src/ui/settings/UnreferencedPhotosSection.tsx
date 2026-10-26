import { useCallback, useEffect, useId, useState } from 'react';
import { realTimers, type TimerPort } from '../../collab/timers';
import type { MediaReconciler, RemoveUnreferencedResult } from '../../media/reconcile';
import type { MediaStore } from '../../media/store';
import { ConfirmDialog } from '../ConfirmDialog';
import { Button, Notice } from '../kit';
import { useActionLatch } from '../latch';
import { LiveNote } from '../worklist/LiveNote';

export const CHECK_FAILED = 'The photos could not be checked. Try again.';
export const REMOVE_FAILED = 'The photos could not be removed. Try again.';
export const CHECKING = 'Checking photos…';
/** How long a look may take before the screen says it is still working. */
export const CHECKING_AFTER_MS = 1000;
export const REMOVE_DESCRIPTION = 'These photos are already on the server, but the app found no place for them in the inspection. This removes only the copies on this device. This cannot be undone.';

export interface UnreferencedPhotosSectionProps {
  store: Pick<MediaStore, 'listRows'>;
  reconciler: Pick<MediaReconciler, 'idle' | 'recheckMissing' | 'countUnreferenced' | 'removeUnreferenced'>;
  timers?: TimerPort;
}

interface Found {
  /** Photos and clips on the server whose last step, the entry in the inspection, has not been made. Read from the stored rows, so it survives a restart. */
  uploaded: number;
  /** Those of them the last look found no entry for. A person may remove these; the others may still attach by themselves. */
  unreferenced: number;
}

function removalNote(result: RemoveUnreferencedResult): string {
  const parts: string[] = [];
  if (result.removed > 0) parts.push(`Removed ${noun(result.removed)} from this device.`);
  if (result.attached > 0) parts.push(`${noun(result.attached)} could be attached to the inspection after all, so ${result.attached === 1 ? 'it was' : 'they were'} kept in it.`);
  if (result.skipped > 0) parts.push(`${noun(result.skipped)} could not be checked and ${result.skipped === 1 ? 'was' : 'were'} left on this device.`);
  return parts.length === 0 ? 'Nothing was removed.' : parts.join(' ');
}

const noun = (count: number): string => (count === 1 ? '1 photo or clip' : `${String(count)} photos or clips`);

/**
 * Photos and clips that reached the server but were never attached to anything (typically a defect that was deleted before its
 * photo finished uploading). No other count shows them: they are not waiting to upload and nothing is at risk of being lost.
 * Opening the screen asks for one fresh look, and the number is read once that look is over. Nothing is removed without a
 * confirmation, and only photos the last look found no entry for can be removed. The section is absent when there are none.
 */
export function UnreferencedPhotosSection({ store, reconciler, timers = realTimers }: UnreferencedPhotosSectionProps) {
  const headingId = useId();
  const [found, setFound] = useState<Found | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [slow, setSlow] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const latch = useActionLatch();

  const look = useCallback(async (): Promise<Found> => {
    reconciler.recheckMissing();
    await reconciler.idle();
    const rows = await store.listRows({ states: ['uploaded'] });
    return { uploaded: rows.length, unreferenced: reconciler.countUnreferenced() };
  }, [store, reconciler]);

  useEffect(() => {
    let current = true;
    // A run of uploads can keep the first look waiting for a long time: after a moment the screen says so instead of showing nothing.
    const timer = timers.setTimeout(() => {
      if (current) setSlow(true);
    }, CHECKING_AFTER_MS);
    const done = (): void => {
      timers.clearTimeout(timer);
      if (current) setSlow(false);
    };
    look().then(
      (result) => {
        done();
        if (current) setFound(result);
      },
      done,
    );
    return () => {
      current = false;
      timers.clearTimeout(timer);
    };
  }, [look, timers]);

  async function check(): Promise<void> {
    setFailed(null);
    setNote('');
    try {
      setFound(await look());
    } catch {
      setFailed(CHECK_FAILED);
    }
  }

  async function remove(): Promise<void> {
    setRemoveError(null);
    setRemoving(true);
    try {
      const result = await reconciler.removeUnreferenced();
      setConfirming(false);
      setNote(removalNote(result));
      setFound(await look());
    } catch {
      setRemoveError(REMOVE_FAILED);
    } finally {
      setRemoving(false);
    }
  }

  function closeDialog(): void {
    setConfirming(false);
    setRemoveError(null);
  }

  if (found === null) {
    if (!slow) return null;
    return (
      <section aria-labelledby={headingId} className="flex flex-col gap-3">
        <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
          Photos not attached
        </h2>
        <p role="status" className="text-sm leading-relaxed text-ih-fg-2">
          {CHECKING}
        </p>
      </section>
    );
  }
  if (found.uploaded === 0 && note === '') return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        Photos not attached
      </h2>
      {found.uploaded > 0 && (
        <p className="text-base leading-relaxed text-ih-fg-2">{`${noun(found.uploaded)} on this device ${found.uploaded === 1 ? 'is' : 'are'} on the server but not attached to an inspection yet.${found.unreferenced > 0 ? ` ${noun(found.unreferenced)} could not be placed and can be removed.` : ''}`}</p>
      )}
      {failed !== null && <Notice tone="bad">{failed}</Notice>}
      <LiveNote testId="unreferenced-note" className="text-sm leading-relaxed text-ih-fg-2" text={note} />
      {found.uploaded > 0 && (
        <div className="flex flex-col gap-3">
          <Button variant="secondary" onClick={() => void latch(check)}>
            Check again
          </Button>
          {found.unreferenced > 0 && (
            <Button variant="secondary" aria-label={`Remove from this device, ${noun(found.unreferenced)}`} onClick={() => setConfirming(true)}>
              Remove from this device…
            </Button>
          )}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title={`Remove ${noun(found.unreferenced)} from this device?`}
          description={REMOVE_DESCRIPTION}
          confirmLabel="Remove"
          destructive
          busy={removing}
          error={removeError}
          onConfirm={() => void latch(remove)}
          onCancel={closeDialog}
        />
      )}
    </section>
  );
}
