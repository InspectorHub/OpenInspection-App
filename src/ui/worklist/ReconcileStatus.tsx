import { useState } from 'react';
import type { ReconcileOutcome } from '../../offline/reconciler';
import { Button, Notice } from '../kit';
import { useActionLatch } from '../latch';
import { checkedLabel } from './format';

export interface ReconcileStatusProps {
  outcome: ReconcileOutcome;
  now: number;
  locale: string | undefined;
  /** Asks for a check. Fire and forget: the answer arrives as the next outcome. */
  onCheck(): void;
  /** Moves to the queued changes that block the check. Only offered when there are some. */
  onReview: (() => void) | null;
}

/** What the last check of the server's list said, in fixed words, and the way to ask again. Nothing is ever removed from here. */
export function ReconcileStatus({ outcome, now, locale, onCheck, onReview }: ReconcileStatusProps) {
  const [asked, setAsked] = useState<{ at: number | null } | null>(null);
  const latch = useActionLatch();
  const single = outcome.allMissing && outcome.candidateCount === 1;
  const failed = outcome.status === 'failed' || outcome.status === 'error';

  return (
    <section aria-label="Server check" className="flex flex-col gap-2">
      {outcome.allMissing && !single && (
        <Notice tone="watch">The server lost track of all of your inspections. This can mean you are signed in to the wrong account or server, or that they were removed. Nothing was removed.</Notice>
      )}
      {single && <Notice tone="watch">This inspection is no longer on your list. Nothing was removed automatically.</Notice>}
      {outcome.massSuspicious && !outcome.allMissing && (
        <Notice tone="watch">The server did not list many of your inspections. Nothing was removed automatically. Check your connection and account, then try again.</Notice>
      )}
      {outcome.refusedNullInspectionId && (
        <Notice tone="watch">
          <p>A queued change could not be matched to an inspection. Review the queued changes below.</p>
          {onReview !== null && (
            <Button variant="quiet" className="mt-2" onClick={onReview}>
              Review queued changes
            </Button>
          )}
        </Notice>
      )}
      {failed && <Notice tone="info">Could not check the server for removed inspections. Nothing was removed.</Notice>}
      {outcome.resumeFailed && <Notice tone="watch">A removal that stopped halfway could not be finished. It will be tried again.</Notice>}
      {outcome.unavailableRole && <p className="text-sm text-ih-fg-3">Cleanup of removed inspections is not available for your role.</p>}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ih-fg-3">{checkedLabel(outcome.at, now, locale)}</p>
        <Button
          variant="quiet"
          className="w-auto!"
          onClick={() =>
            void latch(async () => {
              onCheck();
              setAsked({ at: outcome.at });
            })
          }
        >
          Check now
        </Button>
      </div>
      <p aria-live="polite" className="min-h-5 text-sm text-ih-fg-3">
        {asked !== null && asked.at === outcome.at ? 'Check requested.' : ''}
      </p>
    </section>
  );
}
