import { useEffect, useId, useRef, useState } from 'react';
import type { AppServices } from '../../app/compose';
import type { OfflineStack } from '../../app/offline-stack';
import { SYNC_WINDOW_CHOICES, syncWindowChoice, writeSyncDays, type SyncWindowChoice } from '../../offline/sync-window';
import { readSyncDays } from '../../offline/work-package';
import { Notice } from '../kit';
import { useActionLatch } from '../latch';
import { REFRESH_THREW_TEXT, refreshSummaryText } from '../worklist/copy';
import { LiveNote } from '../worklist/LiveNote';

export const SAVE_FAILED = 'The setting could not be saved. Try again.';
export const SYNC_LEGEND = 'Also keep finished work from around today, up to this many days ahead';
export const UNFINISHED_ALWAYS = 'Inspections that are not finished are always downloaded.';
export const SAVED_OFFLINE_WORK = 'Saved. The next download uses this window.';

export interface SyncSectionProps {
  services: Pick<AppServices, 'db'>;
  /** Where the refresh runs. Null where no session runs: the choice is saved and the next download uses it. */
  stack: OfflineStack | null;
  /** False while the server is too old for the app: the choice is saved, nothing is requested. */
  canSync: boolean;
}

/**
 * How many days ahead the work list downloads. A choice is saved at once, asks for one download, and never removes anything that is
 * already on the device: a narrower window only means less is fetched next time.
 */
export function SyncSection({ services, stack, canSync }: SyncSectionProps) {
  const headingId = useId();
  const name = useId();
  const [days, setDays] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState(false);
  const latch = useActionLatch();
  // One download at a time from this screen. The refresher joins a run already in flight, and that run read the window before the
  // latest choice, so a choice made meanwhile queues exactly one more download after it.
  const running = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    let current = true;
    readSyncDays(services.db).then(
      (value) => {
        if (current) setDays(value);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [services.db]);

  async function save(choice: SyncWindowChoice): Promise<boolean> {
    if (choice === days) return false;
    setFailed(false);
    setNote('');
    try {
      await writeSyncDays(services.db, choice);
    } catch {
      setFailed(true);
      return false;
    }
    setDays(choice);
    return true;
  }

  async function choose(choice: SyncWindowChoice): Promise<void> {
    let saved = false;
    // The latch covers the write only: a choice made while the download runs is saved and asks for its own download.
    await latch(async () => {
      saved = await save(choice);
    });
    if (!saved) return;
    if (stack === null || !canSync) {
      setNote(SAVED_OFFLINE_WORK);
      return;
    }
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        again.current = false;
        setNote('Saved. Downloading…');
        try {
          setNote(refreshSummaryText(await stack.refresher.refresh({ reason: 'manual' })));
        } catch {
          setNote(REFRESH_THREW_TEXT);
        }
      } while (again.current);
    } finally {
      running.current = false;
    }
  }

  const selected = days === null ? null : syncWindowChoice(days);
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        Sync
      </h2>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-base text-ih-fg-2">{SYNC_LEGEND}</legend>
        {SYNC_WINDOW_CHOICES.map((choice) => (
          <label key={choice} className="flex min-h-11 items-center gap-3 text-base text-ih-fg-1">
            <input type="radio" name={name} className="size-5 shrink-0 accent-ih-primary" value={choice} checked={selected === choice} disabled={days === null} onChange={() => void choose(choice)} />
            {`${String(choice)} days`}
          </label>
        ))}
      </fieldset>
      <p className="text-sm leading-relaxed text-ih-fg-3">{UNFINISHED_ALWAYS}</p>
      {failed && <Notice tone="bad">{SAVE_FAILED}</Notice>}
      <LiveNote testId="sync-note" className="text-sm leading-relaxed text-ih-fg-2" text={note} />
    </section>
  );
}
