import { useEffect, useState } from 'react';
import type { Account } from '../../offline/outbox';
import { namesMassSuspicious } from '../../offline/purge';
import { planIsStale, type ReconcilePlan } from '../../offline/reconcile-decision';
import { unsentData, type UnsentResult } from '../../offline/unsent';
import type { RemoveOutcome, RemoveOptions } from '../../offline/user-actions';
import { ConfirmDialog } from '../ConfirmDialog';
import { useActionLatch } from '../latch';
import { COUNTS_FAILED, REMOVE_THREW_TEXT, removeFailureText } from './copy';
import type { WorkListRow, WorkListStack } from './model';
import { REMOVE_LABEL } from './InspectionRow';

export interface RemoveDialogProps {
  stack: WorkListStack;
  row: WorkListRow;
  now(): number;
  onClose(): void;
  /** The inspection is gone from the device. */
  onRemoved(): void;
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
 * they have not been shown. Only reachable for a quarantined row or one the latest suspicious answer names.
 */
export function RemoveDialog({ stack, row, now, onClose, onRemoved }: RemoveDialogProps) {
  const [counts, setCounts] = useState<Counts>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latch = useActionLatch();

  useEffect(() => {
    let live = true;
    unsentData(stack.db, row.id, stack.account).then(
      (result) => {
        if (live) setCounts({ kind: 'ready', result });
      },
      () => {
        if (live) setCounts({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [stack, row.id]);

  async function remove(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const plan = planFor(stack, row.id, stack.account, now());
      const options: RemoveOptions = plan === null ? { confirmed: true } : { confirmed: true, plan };
      const outcome: RemoveOutcome = await stack.userActions.removeFromDevice(row.id, options);
      if (outcome.kind === 'purged') onRemoved();
      else setError(removeFailureText(outcome));
    } catch {
      setError(REMOVE_THREW_TEXT);
    } finally {
      setBusy(false);
    }
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
      description="This removes the inspection and everything stored for it on this device. This cannot be undone."
      confirmLabel={REMOVE_LABEL}
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
