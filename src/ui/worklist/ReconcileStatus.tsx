import { useEffect, useState } from 'react';
import type { TimerPort } from '../../collab/timers';
import type { ReconcileOutcome } from '../../offline/reconciler';
import { Button, Notice } from '../kit';
import { useActionLatch } from '../latch';
import { CHECK_IGNORED, CHECK_REQUESTED, CHECK_THREW } from './copy';
import { checkedLabel } from './format';
import { LiveNote } from './LiveNote';

/** How long "Check requested." stays when no outcome arrives: a check that never runs must not look like one that is coming. */
export const CHECK_NOTE_MS = 10_000;

export interface ReconcileStatusProps {
  outcome: ReconcileOutcome;
  now: number;
  locale: string | undefined;
  /** Asks for a check. Fire and forget: the answer arrives as the next outcome. */
  onCheck(): void;
  /**
   * Whether a check can run right now. The reconciler gives no answer to a trigger and ignores one while the device is offline
   * or locked and before its first flow has finished, so the screen derives this from the link and the latest outcome.
   */
  canRun: boolean;
  /** The timers that end the note. */
  timers: TimerPort;
  /** Moves to the queued changes that block the check. Only offered when there are some. */
  onReview: (() => void) | null;
}

/** What the last check of the server's list said, in fixed words, and the way to ask again. Nothing is ever removed from here. */
export function ReconcileStatus({ outcome, now, locale, onCheck, canRun, timers, onReview }: ReconcileStatusProps) {
  const [asked, setAsked] = useState<{ at: number | null; note: string; id: number } | null>(null);
  const latch = useActionLatch();

  // The note ends after a bounded time, whatever happened; a newer request restarts the time.
  const askedId = asked?.id;
  useEffect(() => {
    if (askedId === undefined) return undefined;
    const handle = timers.setTimeout(() => setAsked(null), CHECK_NOTE_MS);
    return () => timers.clearTimeout(handle);
  }, [askedId, timers]);
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
              const id = (asked?.id ?? 0) + 1;
              try {
                onCheck();
                setAsked({ at: outcome.at, note: canRun ? CHECK_REQUESTED : CHECK_IGNORED, id });
              } catch {
                setAsked({ at: outcome.at, note: CHECK_THREW, id });
              }
            })
          }
        >
          Check now
        </Button>
      </div>
      <LiveNote className="text-sm text-ih-fg-3" text={asked !== null && asked.at === outcome.at ? asked.note : ''} />
    </section>
  );
}
