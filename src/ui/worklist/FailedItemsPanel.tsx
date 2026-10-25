import { useId, useState } from 'react';
import { Button } from '../kit';
import { ConfirmDialog } from '../ConfirmDialog';
import { useActionLatch } from '../latch';
import { DISCARD_CHANGE_GONE, DISCARD_THREW, OUTBOX_ERROR_TEXT, OUTBOX_ERROR_UNKNOWN, RETRY_THREW, bytesLabel, discardMediaFailureText, opConsequence, opLabel } from './copy';
import { shortTitle } from './format';
import type { FailedMediaItem, FailedOutboxItem, WorkListRow, WorkListStack } from './model';
import { DISCARD_AND_REMOVE_LABEL, RemoveDialog } from './RemoveDialog';

export interface FailedItemsPanelProps {
  stack: WorkListStack;
  rows: readonly WorkListRow[];
  outbox: readonly FailedOutboxItem[];
  media: readonly FailedMediaItem[];
  now(): number;
  /** Reads the list again after anything changed. */
  reload(): Promise<void>;
  /** Says something fixed about what just happened, outside this panel (which may be gone by then). */
  notify(message: string): void;
}

type Target = { kind: 'outbox'; item: FailedOutboxItem } | { kind: 'media'; item: FailedMediaItem } | { kind: 'create'; item: FailedOutboxItem; row: WorkListRow };

const isClip = (item: FailedMediaItem): boolean => item.kind === 'video';

function titleOf(rows: readonly WorkListRow[], id: string | null): string {
  const row = rows.find((r) => r.id === id);
  return row !== undefined ? shortTitle(row) : id === null ? 'Unknown inspection' : `Inspection ${id.slice(0, 8)}`;
}

/**
 * Queued changes that the server refused for good, and photos and clips that stopped uploading, of this account only. Each
 * can be tried again; a change can be discarded after a confirmation that says what will not be sent; a stuck photo can be
 * discarded only when its inspection has left the list. A failed create has one exit that does not leave a half-made
 * inspection behind: discarding it and removing the inspection together. Every line of explanation is ours, chosen by the
 * code, never the server's words, and a failing action shows a fixed line, never the error.
 */
export function FailedItemsPanel({ stack, rows, outbox, media, now, reload, notify }: FailedItemsPanelProps) {
  const headingId = useId();
  const [target, setTarget] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const latch = useActionLatch();

  const empty = outbox.length === 0 && media.length === 0;
  if (empty && target === null) return null;

  function close(): void {
    setTarget(null);
    setError(null);
  }

  async function retry(run: () => Promise<unknown>): Promise<void> {
    setRetryError(null);
    try {
      await run();
      await reload();
    } catch {
      setRetryError(RETRY_THREW);
    }
  }

  async function discard(): Promise<void> {
    if (target === null || target.kind === 'create') return;
    setError(null);
    setBusy(true);
    try {
      if (target.kind === 'outbox') {
        const done = await stack.replayer.discard(target.item.key, { confirmed: true });
        if (!done) {
          setError(DISCARD_CHANGE_GONE);
          return;
        }
      } else {
        const result = await stack.userActions.discardMedia(target.item.pendingId, { confirmed: true });
        if (result.kind !== 'discarded') {
          setError(discardMediaFailureText(result));
          return;
        }
      }
      close();
      await reload();
    } catch {
      setError(DISCARD_THREW);
    } finally {
      setBusy(false);
    }
  }

  const quarantinedMedia = (item: FailedMediaItem): boolean => rows.find((r) => r.id === item.inspectionId)?.blocked === 'quarantined';
  /** The package a failed create made, when it is still on the list: then discarding and removing go together. */
  const packageOf = (item: FailedOutboxItem): WorkListRow | undefined => (item.isCreate ? rows.find((r) => r.id === item.inspectionId) : undefined);

  const createDialog =
    target !== null && target.kind === 'create' ? (
      <RemoveDialog
        stack={stack}
        row={target.row}
        discardKey={target.item.key}
        now={now}
        reload={reload}
        onClose={close}
        onRemoved={() => {
          close();
          notify('Removed from this device.');
          void reload();
        }}
        onUnavailable={(message) => {
          close();
          notify(message);
        }}
      />
    ) : null;
  // The queued create is gone after its discard; the dialog stays (at the same place in the tree, so it is not rebuilt) so that
  // a removal that failed afterwards is still seen.
  return (
    <>
      {!empty && (
        <section aria-labelledby={headingId} className="flex flex-col gap-3">
          <h2 id={headingId} className="font-ih-display text-base font-bold text-ih-bad-fg">
            Needs attention
          </h2>
          {retryError !== null && (
            <p role="alert" className="text-sm text-ih-bad-fg">
              {retryError}
            </p>
          )}
          <ul className="flex flex-col gap-3">
            {outbox.map((item) => {
              const made = packageOf(item);
              return (
                <li key={item.key} className="flex flex-col gap-2 rounded-ih-card border border-l-4 border-ih-border border-l-ih-bad bg-ih-bg-card p-3">
                  <p className="font-semibold text-ih-fg-1">{opLabel(item.op)}</p>
                  <p className="break-words text-sm text-ih-fg-3 [overflow-wrap:anywhere]">{titleOf(rows, item.inspectionId)}</p>
                  <p className="text-sm leading-relaxed text-ih-fg-2">{item.error === null ? OUTBOX_ERROR_UNKNOWN : OUTBOX_ERROR_TEXT[item.error]}</p>
                  <p className="text-sm text-ih-fg-3">{bytesLabel(item.bytes)}</p>
                  <div className="flex flex-wrap gap-3">
                    <Button variant="secondary" aria-label={`Retry ${opLabel(item.op)}, ${titleOf(rows, item.inspectionId)}`} onClick={() => void latch(() => retry(() => stack.replayer.retry(item.key)))}>
                      Retry
                    </Button>
                    {made !== undefined ? (
                      <Button variant="secondary" aria-label={`${DISCARD_AND_REMOVE_LABEL}, ${titleOf(rows, item.inspectionId)}`} onClick={() => setTarget({ kind: 'create', item, row: made })}>
                        {DISCARD_AND_REMOVE_LABEL}
                      </Button>
                    ) : (
                      <Button variant="secondary" aria-label={`Discard ${opLabel(item.op)}, ${titleOf(rows, item.inspectionId)}`} onClick={() => setTarget({ kind: 'outbox', item })}>
                        Discard…
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
            {media.map((item) => (
              <li key={item.pendingId} className="flex flex-col gap-2 rounded-ih-card border border-l-4 border-ih-border border-l-ih-bad bg-ih-bg-card p-3">
                <p className="font-semibold text-ih-fg-1">{isClip(item) ? 'Clip' : 'Photo'}</p>
                <p className="break-words text-sm text-ih-fg-3 [overflow-wrap:anywhere]">{titleOf(rows, item.inspectionId)}</p>
                <p className="text-sm leading-relaxed text-ih-fg-2">{isClip(item) ? 'The clip could not be uploaded.' : 'The photo could not be uploaded.'}</p>
                <div className="flex gap-3">
                  <Button variant="secondary" aria-label={`Retry ${isClip(item) ? 'clip' : 'photo'}, ${titleOf(rows, item.inspectionId)}`} onClick={() => void latch(() => retry(() => stack.uploader.retry(item.pendingId)))}>
                    Retry
                  </Button>
                  {quarantinedMedia(item) && (
                    <Button variant="secondary" onClick={() => setTarget({ kind: 'media', item })}>
                      {isClip(item) ? 'Discard clip' : 'Discard photo'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {target !== null && target.kind === 'outbox' && (
            <ConfirmDialog
              title="Discard this queued change?"
              description={`${opLabel(target.item.op)} for ${titleOf(rows, target.item.inspectionId)}. ${opConsequence(target.item.op)} The queued change will be permanently removed (${bytesLabel(target.item.bytes)}). This cannot be undone.`}
              confirmLabel="Discard change"
              destructive
              busy={busy}
              error={error}
              onConfirm={() => void latch(discard)}
              onCancel={close}
            />
          )}
          {target !== null && target.kind === 'media' && (
            <ConfirmDialog
              title={isClip(target.item) ? 'Discard this clip?' : 'Discard this photo?'}
              description="The file will be permanently removed from this device. This cannot be undone."
              confirmLabel={isClip(target.item) ? 'Discard clip' : 'Discard photo'}
              destructive
              busy={busy}
              error={error}
              onConfirm={() => void latch(discard)}
              onCancel={close}
            />
          )}
        </section>
      )}
      {createDialog}
    </>
  );
}
