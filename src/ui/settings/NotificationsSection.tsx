import { useCallback, useEffect, useId, useState } from 'react';
import type { AppServices } from '../../app/compose';
import type { NotificationState } from '../../platform/notifications';
import { Body, Button } from '../kit';
import { useActionLatch } from '../latch';

export const NOTIFICATIONS_OFF =
  'Notifications are off for this app. Android keeps uploads running in the background and shows them as a notification. To turn them on, open Android Settings, then Apps, InspectorHub, Notifications.';
export const NOTIFICATIONS_OPEN = 'Android shows a notification while photos upload in the background. Turn notifications on to see it.';

export interface NotificationsSectionProps {
  services: Pick<AppServices, 'notifications' | 'notificationAsk'>;
}

/**
 * The state of the notification permission. Shown only where the app needs one (Android). When the question is still open a button
 * asks it; once Android has refused, the system does not show its prompt again, so the way back is described in words. The state is
 * read again whenever the app becomes visible, which is how a change made in Android Settings shows up here.
 */
export function NotificationsSection({ services }: NotificationsSectionProps) {
  const headingId = useId();
  const [state, setState] = useState<NotificationState | null>(null);
  const latch = useActionLatch();

  const read = useCallback((): void => {
    services.notifications.check().then(setState, () => setState('unsupported'));
  }, [services.notifications]);

  useEffect(() => {
    read();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') read();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [read]);

  if (state === null || state === 'unsupported') return null;

  async function turnOn(): Promise<void> {
    try {
      setState(await services.notificationAsk.accept());
    } catch {
      setState('unsupported');
    }
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        Notifications
      </h2>
      <p data-testid="notification-state" className="text-base font-semibold text-ih-fg-1">
        {state === 'granted' ? 'On' : 'Off'}
      </p>
      {state !== 'granted' && <Body>{state === 'prompt' ? NOTIFICATIONS_OPEN : NOTIFICATIONS_OFF}</Body>}
      {state === 'prompt' && (
        <Button variant="secondary" onClick={() => void latch(turnOn)}>
          Turn on notifications
        </Button>
      )}
    </section>
  );
}
