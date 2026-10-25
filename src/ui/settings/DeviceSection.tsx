import { useEffect, useId, useState } from 'react';
import type { AppServices } from '../../app/compose';
import { loadLockState } from '../../offline/lock-state';
import { checkedLabel, dateLabel } from '../worklist/format';

export interface DeviceSectionProps {
  services: Pick<AppServices, 'db' | 'clock'>;
  origin: string;
  /** Items still to upload, or null until the first read. */
  waiting: number | null;
  locale: string | undefined;
}

interface Verification {
  at: number | null;
  days: number | null;
}

function items(count: number): string {
  return `${String(count)} ${count === 1 ? 'item' : 'items'}`;
}

/** The server, the offline limit, when this device last proved itself to the server, and what is still to upload. */
export function DeviceSection({ services, origin, waiting, locale }: DeviceSectionProps) {
  const headingId = useId();
  const [state, setState] = useState<Verification | 'unreadable' | null>(null);

  useEffect(() => {
    let current = true;
    loadLockState(services.db).then(
      (input) => {
        if (current) setState({ at: input.lastVerifiedAt, days: Number.isInteger(input.offlineMaxDays) && input.offlineMaxDays >= 1 ? input.offlineMaxDays : null });
      },
      () => {
        if (current) setState('unreadable');
      },
    );
    return () => {
      current = false;
    };
  }, [services.db]);

  const verification = state === null || state === 'unreadable' ? null : state;
  // The clock is the app's own (the one the lock uses), never a locale call without a time zone.
  const now = services.clock.now();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        This device
      </h2>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-base">
        <dt className="text-ih-fg-3">Server</dt>
        <dd data-testid="settings-server" className="break-all font-ih-mono text-sm text-ih-fg-1">
          {origin}
        </dd>
        <dt className="text-ih-fg-3">Offline limit</dt>
        <dd data-testid="settings-offline-limit" className="text-ih-fg-1">
          {state === 'unreadable' ? 'Unavailable' : verification === null ? '…' : verification.days === null ? 'Not set' : `${String(verification.days)} ${verification.days === 1 ? 'day' : 'days'}`}
        </dd>
        <dt className="text-ih-fg-3">Last verified</dt>
        <dd data-testid="settings-last-verified" className="text-ih-fg-1">
          {state === 'unreadable' ? 'Unavailable' : verification === null ? '…' : verification.at === null ? 'Not verified yet' : dateLabel(verification.at, locale)}
          {verification?.at != null && <span className="block text-sm text-ih-fg-3">{checkedLabel(verification.at, now, locale)}</span>}
        </dd>
        <dt className="text-ih-fg-3">Waiting to upload</dt>
        <dd data-testid="settings-waiting" className="text-ih-fg-1">
          {waiting === null ? '…' : items(waiting)}
        </dd>
      </dl>
    </section>
  );
}
