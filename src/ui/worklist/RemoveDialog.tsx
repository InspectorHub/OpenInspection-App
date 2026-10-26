import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account } from '../../offline/outbox';
import { namesMassSuspicious } from '../../offline/purge';
import { planIsStale, type ReconcilePlan } from '../../offline/reconcile-decision';
import { unsentData, type UnsentResult } from '../../offline/unsent';
import type { RemoveOutcome, RemoveOptions } from '../../offline/user-actions';
import { ConfirmDialog } from '../ConfirmDialog';
import { useActionLatch } from '../latch';
import { COUNTS_FAILED, DISCARD_CHANGE_GONE, discardChangeFailureText, REMOVE_GONE, REMOVE_NOT_ALLOWED, REMOVE_RUNNING, REMOVE_THREW_TEXT, removeFailureText } from './copy';
import { REMOVE_LABEL } from './InspectionRow';
import { readWorkListSnapshot, type WorkListRow, type WorkListStack } from './model';

export const DISCARD_AND_REMOVE_LABEL = 'Discard and remove this inspection from this device';

export interface RemoveDialogProps {
  stack: WorkListStack;
  row: Pick<WorkListRow, 'id' | 'neverSent'>;
  /**
   * The key of the failed `inspection.create` of this inspection. When given, confirming discards that queued write first
   * and then removes the inspection that was never sent, so there is one action and no half-done state to find later.
   */
  discardKey?: string;
  now(): number;
  /** Reads the list again. Called after every attempt that did not remove the inspection. */
  reload(): Promise<void>;
  onClose(): void;
  /** The inspection is gone from the device. */
  onRemoved(): void;
  /** The inspection can no longer be removed from here (it is gone, or no longer removable): the dialog closes with this fixed message. */
  onUnavailable(message: string): void;
}

type Counts = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; result: UnsentResult };

/** The plan to hand over, read fresh at the moment of confirming: the exact object, or none. Never copied. */
function planFor(stack: Pick<WorkListStack, 'lastPlan'>, id: string, account: Account, now: number): ReconcilePlan | null {
  const plan = stack.lastPlan();
  return plan !== null && !planIsStale(plan, now) && namesMassSuspicious(plan, id, account) ? plan : null;
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No';
}

/**
 * Asks before the data of one inspection leaves this device. The counts are read when the dialog opens, from the same
 * predicate the removal itself checks, and the confirm button stays off until they are known: nobody confirms a loss
 * they have not been shown. After any attempt that did not remove it, the counts and the row are read again, so the
 * next confirmation is made on what is true now; if the inspection can no longer be removed the dialog closes.
 * Reachable for a quarantined row, one the latest suspicious answer names, and one that was never sent.
 */
export function RemoveDialog({ stack, row, discardKey, now, reload, onClose, onRemoved, onUnavailable }: RemoveDialogProps) {
  const [counts, setCounts] = useState<Counts>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latch = useActionLatch();
  const newest = useRef(0);
  const alive = useRef(true);
  const neverSent = discardKey !== undefined || row.neverSent;

  const readCounts = useCallback(async (): Promise<void> => {
    newest.current += 1;
    const mine = newest.current;
    try {
      const result = await unsentData(stack.db, row.id, stack.account);
      if (alive.current && mine === newest.current) setCounts({ kind: 'ready', result });
    } catch {
      if (alive.current && mine === newest.current) setCounts({ kind: 'failed' });
    }
  }, [stack, row.id]);

  useEffect(() => {
    alive.current = true;
    void readCounts();
    return () => {
      alive.current = false;
    };
  }, [readCounts]);

  /** What is true now: false when the dialog was closed because the inspection can no longer be removed. */
  async function stillRemovable(): Promise<boolean> {
    try {
      const fresh = (await readWorkListSnapshot(stack, now())).rows.find((r) => r.id === row.id);
      if (fresh === undefined) onUnavailable(REMOVE_GONE);
      else if (fresh.blocked === 'purging') onUnavailable(REMOVE_RUNNING);
      else if (!fresh.removable && !(discardKey !== undefined && fresh.createdLocally)) onUnavailable(REMOVE_NOT_ALLOWED);
      else return true;
      return false;
    } catch {
      return true;
    }
  }

  async function remove(): Promise<void> {
    setError(null);
    setBusy(true);
    let message: string | null = null;
    try {
      if (discardKey !== undefined) {
        const result = await stack.replayer.discard(discardKey, { confirmed: true });
        // Nothing found to discard is fine when the queued create is already gone; the removal re-checks it either way.
        if (result.kind === 'locked' || result.kind === 'busy') message = discardChangeFailureText(result);
        else if (result.kind === 'not_found' && (await createStillQueued(stack, discardKey))) message = DISCARD_CHANGE_GONE;
      }
      if (message === null) {
        const plan = planFor(stack, row.id, stack.account, now());
        const options: RemoveOptions = plan === null ? { confirmed: true } : { confirmed: true, plan };
        const outcome: RemoveOutcome = await stack.userActions.removeFromDevice(row.id, options);
        if (outcome.kind === 'purged') {
          onRemoved();
          return;
        }
        message = removeFailureText(outcome);
      }
    } catch {
      message = REMOVE_THREW_TEXT;
    } finally {
      setBusy(false);
    }
    setError(message);
    await reload();
    if (await stillRemovable()) await readCounts();
  }

  const ready = counts.kind === 'ready' ? counts.result : null;
  const details =
    counts.kind === 'loading' ? (
      <p role="status" className="text-sm text-ih-fg-3">
        Checking what is on this device…
      </p>
    ) : ready === null ? null : (
      <ul className="flex flex-col gap-1 rounded-ih-card bg-ih-bg-muted px-3 py-2 text-sm text-ih-fg-1">
        <li>{`Edits on this device that are not on the server: ${yesNo(ready.reasons.includes('ydoc_not_on_server'))}`}</li>
        <li>{`Photos and clips waiting to upload: ${String(ready.counts.media.notUploaded + ready.counts.media.unknownState)}`}</li>
        <li>{`Queued changes: ${String(ready.counts.outbox.pending + ready.counts.outbox.failed + ready.counts.outbox.orphaned + ready.counts.outbox.other)}`}</li>
        {ready.counts.createdLocally && <li>Created on this device and never sent: Yes</li>}
      </ul>
    );

  return (
    <ConfirmDialog
      title="Remove this inspection from this device?"
      description={
        neverSent
          ? 'This inspection was never sent to the server. Everything on this device for it, including photos and edits, will be permanently removed. If the server already received it, it will appear again the next time you download your work; anything you added only on this device will be lost. This cannot be undone.'
          : 'This removes the inspection and everything stored for it on this device. This cannot be undone.'
      }
      confirmLabel={discardKey !== undefined ? DISCARD_AND_REMOVE_LABEL : REMOVE_LABEL}
      destructive
      details={details}
      confirmDisabled={counts.kind !== 'ready'}
      busy={busy}
      error={counts.kind === 'failed' ? COUNTS_FAILED : error}
      onConfirm={() => void latch(remove)}
      onCancel={onClose}
    />
  );
}

async function createStillQueued(stack: Pick<WorkListStack, 'db'>, key: string): Promise<boolean> {
  try {
    return (await stack.db.query('SELECT 1 FROM outbox WHERE idempotency_key = ?', [key])).length > 0;
  } catch {
    return true;
  }
}
