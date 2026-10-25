import { useId, useState, type Ref } from 'react';
import { Button } from '../kit';
import { ConfirmDialog } from '../ConfirmDialog';
import { useActionLatch } from '../latch';
import { DISCARD_THREW, OUTBOX_ERROR_TEXT, OUTBOX_ERROR_UNKNOWN, discardMediaFailureText, discardOutboxFailureText, opLabel, plural } from './copy';
import type { FailedMediaItem, RepairItem, WorkListStack } from './model';

export interface RepairPanelProps {
  stack: WorkListStack;
  rows: readonly RepairItem[];
  /** Queued changes of other accounts: counted, never listed. */
  foreign: number;
  /** Stuck photos and clips whose inspection has no package on this device. They can be discarded, never retried. */
  orphanMedia: readonly FailedMediaItem[];
  /** Stuck photos and clips of another account: counted, never listed. */
  foreignMedia: number;
  reload(): Promise<void>;
  headingRef: Ref<HTMLHeadingElement>;
}

interface Removed {
  payload: string;
}

type CopyState = 'idle' | 'copied' | 'failed';

function canCopy(): boolean {
  if (typeof navigator === 'undefined') return false;
  const clipboard = navigator.clipboard as Clipboard | undefined;
  return clipboard !== undefined && typeof clipboard.writeText === 'function';
}

type Target = { kind: 'change'; item: RepairItem } | { kind: 'photo'; item: FailedMediaItem };

const isClip = (item: FailedMediaItem): boolean => item.kind === 'video';

/**
 * Photos and clips that belong to no inspection on this device are listed after the queued changes (they have nowhere to be
 * sent, so only a confirmed discard is offered).
 *
 * Queued changes that name no inspection. Each one stops the check for removed inspections until it is gone, and none
 * can be retried (there is nowhere to send it). Discarding hands the stored data back once, so it can be copied before
 * it leaves the screen; the text lives in this component's state only and is never logged.
 */
export function RepairPanel({ stack, rows, foreign, orphanMedia, foreignMedia, reload, headingRef }: RepairPanelProps) {
  const headingId = useId();
  const copyId = useId();
  const photosId = useId();
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const [copy, setCopy] = useState<CopyState>('idle');
  const latch = useActionLatch();

  const queued = rows.length > 0 || foreign > 0 || removed !== null;
  const photos = orphanMedia.length > 0 || foreignMedia > 0;
  if (!queued && !photos && target === null) return null;

  function close(): void {
    setTarget(null);
    setError(null);
  }

  async function discard(): Promise<void> {
    if (target === null) return;
    setError(null);
    setBusy(true);
    try {
      if (target.kind === 'photo') {
        const result = await stack.userActions.discardMedia(target.item.pendingId, { confirmed: true });
        if (result.kind !== 'discarded') {
          setError(discardMediaFailureText(result));
          return;
        }
        close();
        await reload();
        return;
      }
      const result = await stack.userActions.discardOutboxRow(target.item.idempotencyKey, { confirmed: true });
      if (result.kind !== 'discarded') {
        setError(discardOutboxFailureText(result));
        return;
      }
      setRemoved({ payload: result.payload });
      setCopy('idle');
      close();
      await reload();
    } catch {
      setError(DISCARD_THREW);
    } finally {
      setBusy(false);
    }
  }

  async function copyPayload(): Promise<void> {
    if (removed === null) return;
    try {
      await navigator.clipboard.writeText(removed.payload);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <>
      {queued && (
        <section aria-labelledby={headingId} id="repair-panel" className="flex flex-col gap-3">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="font-ih-display text-base font-bold text-ih-fg-1 focus-visible:outline-none focus-visible:shadow-ih-focus">
            Queued changes to review
          </h2>
          {rows.length > 0 && <p className="text-sm leading-relaxed text-ih-fg-2">These queued changes are not linked to an inspection. Until they are removed, the app cannot check for removed inspections.</p>}
          {foreign > 0 && <p className="text-sm leading-relaxed text-ih-fg-2">{`${plural(foreign, 'queued change belongs', 'queued changes belong')} to another account on this device. That account has to sign in to deal with ${foreign === 1 ? 'it' : 'them'}.`}</p>}
          <ul className="flex flex-col gap-3">
            {rows.map((item) => (
              <li key={item.idempotencyKey} className="flex flex-col gap-2 rounded-ih-card border border-l-4 border-ih-border border-l-ih-watch bg-ih-bg-card p-3">
                <p className="font-semibold text-ih-fg-1">{opLabel(item.op)}</p>
                <p className="text-sm leading-relaxed text-ih-fg-2">{item.lastError === null ? OUTBOX_ERROR_UNKNOWN : OUTBOX_ERROR_TEXT[item.lastError]}</p>
                <Button variant="secondary" aria-label={`Discard ${opLabel(item.op)}`} onClick={() => setTarget({ kind: 'change', item })}>
                  Discard…
                </Button>
              </li>
            ))}
          </ul>
          {removed !== null && (
            <section aria-label="Removed. Copy of the change data" className="flex flex-col gap-2 rounded-ih-card border border-ih-border bg-ih-bg-card p-3">
              <p className="font-semibold text-ih-fg-1">Removed. Copy of the change data</p>
              <label htmlFor={copyId} className="sr-only">
                Change data
              </label>
              <textarea id={copyId} readOnly rows={4} value={removed.payload} className="w-full rounded-ih-input border border-ih-border-strong bg-ih-bg-app p-2 font-ih-mono text-xs text-ih-fg-1" />
              <p aria-live="polite" className="min-h-5 text-sm text-ih-fg-3">
                {copy === 'copied' ? 'Copied.' : copy === 'failed' ? 'Could not copy. Select the text and copy it by hand.' : ''}
              </p>
              <div className="flex gap-3">
                {canCopy() && (
                  <Button variant="secondary" onClick={() => void latch(copyPayload)}>
                    Copy
                  </Button>
                )}
                <Button variant="quiet" onClick={() => setRemoved(null)}>
                  Done
                </Button>
              </div>
            </section>
          )}
          {target !== null && target.kind === 'change' && (
            <ConfirmDialog
              title="Discard this queued change?"
              description="The queued change will be permanently removed from this device. You can copy its data afterwards. This cannot be undone."
              confirmLabel="Discard change"
              destructive
              busy={busy}
              error={error}
              onConfirm={() => void latch(discard)}
              onCancel={close}
            />
          )}
        </section>
      )}
      {photos && (
        <section aria-labelledby={photosId} id="orphan-photos" className="flex flex-col gap-3">
          <h2 id={photosId} ref={queued ? undefined : headingRef} tabIndex={-1} className="font-ih-display text-base font-bold text-ih-fg-1 focus-visible:outline-none focus-visible:shadow-ih-focus">
            Orphan photos on this device
          </h2>
          {orphanMedia.length > 0 && <p className="text-sm leading-relaxed text-ih-fg-2">These photos and clips belong to no inspection on this device, so they cannot be sent. You can discard them.</p>}
          {foreignMedia > 0 && (
            <p className="text-sm leading-relaxed text-ih-fg-2">{`${plural(foreignMedia, 'photo or clip belongs', 'photos and clips belong')} to another account on this device. That account has to sign in to deal with ${foreignMedia === 1 ? 'it' : 'them'}.`}</p>
          )}
          <ul className="flex flex-col gap-3">
            {orphanMedia.map((item) => (
              <li key={item.pendingId} className="flex flex-col gap-2 rounded-ih-card border border-l-4 border-ih-border border-l-ih-watch bg-ih-bg-card p-3">
                <p className="font-semibold text-ih-fg-1">{isClip(item) ? 'Clip' : 'Photo'}</p>
                <p className="text-sm leading-relaxed text-ih-fg-2">{isClip(item) ? 'The clip could not be uploaded and has no inspection.' : 'The photo could not be uploaded and has no inspection.'}</p>
                <Button variant="secondary" aria-label={isClip(item) ? 'Discard orphan clip' : 'Discard orphan photo'} onClick={() => setTarget({ kind: 'photo', item })}>
                  {isClip(item) ? 'Discard clip' : 'Discard photo'}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {target !== null && target.kind === 'photo' && (
        <ConfirmDialog
          title={isClip(target.item) ? 'Discard this clip?' : 'Discard this photo?'}
          description="It belongs to no inspection on this device. The file will be permanently removed from this device. This cannot be undone."
          confirmLabel={isClip(target.item) ? 'Discard clip' : 'Discard photo'}
          destructive
          busy={busy}
          error={error}
          onConfirm={() => void latch(discard)}
          onCancel={close}
        />
      )}
    </>
  );
}
