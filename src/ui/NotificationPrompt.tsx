import { useEffect, useState } from 'react';
import type { AppServices } from '../app/compose';
import type { TimerPort } from '../collab/timers';
import { ConfirmDialog } from './ConfirmDialog';
import { useActionLatch } from './latch';
import { useWaitingCount } from './use-waiting-count';

export interface NotificationPromptProps {
  services: Pick<AppServices, 'db' | 'notificationAsk'>;
  /** How many exports have been closed so far. The first one is a moment to explain the permission. */
  exportsClosed: number;
  /** True while another dialog is open: the explanation waits and shows when the way is clear. */
  suspended: boolean;
  timers?: TimerPort;
}

/** Counts uploads only while the explanation is still due, so a device that is done asking reads nothing extra. */
function UnsentWatcher({ db, timers, onUnsent }: { db: AppServices['db']; timers: TimerPort | undefined; onUnsent(): void }) {
  const waiting = useWaitingCount(db, timers === undefined ? {} : { timers });
  useEffect(() => {
    if (waiting !== null && waiting > 0) onUnsent();
  }, [waiting, onUnsent]);
  return null;
}

/**
 * Asks for the notification permission at a moment the person can see why: the first time something is waiting to upload, or the
 * first time an export closes. A short explanation of our own comes first, then Android's prompt. One answer ends it: "Not now" and
 * the system's reply are both remembered, so this never comes back (Settings keeps the way to turn it on later). Renders nothing
 * where no permission is needed.
 */
export function NotificationPrompt({ services, exportsClosed, suspended, timers }: NotificationPromptProps) {
  const [due, setDue] = useState(false);
  const [wanted, setWanted] = useState(false);
  const [busy, setBusy] = useState(false);
  const latch = useActionLatch();
  const ask = services.notificationAsk;

  useEffect(() => {
    let current = true;
    ask.shouldExplain().then(
      (value) => {
        if (current) setDue(value);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [ask]);

  useEffect(() => {
    if (due && exportsClosed > 0) setWanted(true);
  }, [due, exportsClosed]);

  async function answer(accept: boolean): Promise<void> {
    setBusy(true);
    try {
      if (accept) await ask.accept();
      else await ask.decline();
    } catch {
      // The system could not show its prompt; the question is closed all the same.
    }
    setWanted(false);
    setDue(false);
    setBusy(false);
  }

  return (
    <>
      {due && <UnsentWatcher db={services.db} timers={timers} onUnsent={() => setWanted(true)} />}
      {due && wanted && !suspended && (
        <ConfirmDialog
          title="Show upload progress?"
          description="While photos and videos upload in the background, Android shows a notification. Allow notifications to see it. You can change this later in Settings."
          confirmLabel="Allow notifications"
          cancelLabel="Not now"
          busy={busy}
          error={null}
          onConfirm={() => void latch(() => answer(true))}
          onCancel={() => void latch(() => answer(false))}
        />
      )}
    </>
  );
}
