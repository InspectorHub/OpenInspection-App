import { FORMAT_LOCALE } from '../platform/format-locale';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import type { AppServices } from '../app/compose';
import { clientPolicy, factsFor } from '../app/client-state';
import type { OfflineStack } from '../app/offline-stack';
import { useClientState } from '../app/use-client-state';
import type { TimerPort } from '../collab/timers';
import { ClearLocalDataControl } from './ClearLocalDataControl';
import { Button, Screen } from './kit';
import { AboutSection } from './settings/AboutSection';
import { DeviceSection } from './settings/DeviceSection';
import { ExternalLink } from './settings/ExternalLink';
import { NotificationsSection } from './settings/NotificationsSection';
import { SyncSection } from './settings/SyncSection';
import { UnreferencedPhotosSection } from './settings/UnreferencedPhotosSection';
import { SignOutControl } from './SignOutControl';
import { useBackHandler } from './use-back-handler';
import { useWaitingCount } from './use-waiting-count';
import { DesktopSettings } from './DesktopSettings';
import type { DesktopSettingsPort } from '../desktop/updater-port';

export interface SettingsProps {
  services: AppServices;
  origin: string;
  /** The live offline stack of this session, or null where there is none. */
  stack: OfflineStack | null;
  /** Back to the work list. */
  onBack(): void;
  /** Opens the export of everything on the device. */
  onExport(): void;
  onSignedOut(): void;
  onCleared(): void;
  /** See `ClearLocalDataControl`. */
  onWiping?(wiping: boolean): void;
  timers?: TimerPort;
  locale?: string;
  /** Omitted by Capacitor; present only in the Electron renderer. */
  desktop?: DesktopSettingsPort;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Settings: the download window, the facts about this device and its sign-in, notifications, and the things that leave the device
 * (export, clear, sign out, delete account), then the licence and the source code. Export, Clear local data and Sign out are never
 * tied to the server's version policy: whatever else is refused, a person can always get their data out and their sign-in off.
 * The back key and the Back button both return to the list.
 */
export function Settings({ services, origin, stack, onBack, onExport, onSignedOut, onCleared, onWiping, timers, locale, desktop }: SettingsProps) {
  const language = locale ?? FORMAT_LOCALE;
  const state = useClientState(services.clientState);
  const policy = clientPolicy(state, origin);
  const accountUrl = factsFor(state, origin).accountUrl;
  const waiting = useWaitingCount(services.db, timers === undefined ? {} : { timers });
  const heading = useRef<HTMLHeadingElement>(null);

  // A new screen starts at its title, so a screen reader reads where it is.
  useEffect(() => {
    heading.current?.focus();
  }, []);

  useBackHandler(() => {
    onBack();
    return true;
  });

  return (
    <Screen wide>
      <button
        type="button"
        aria-label="Back to work list"
        className="inline-flex min-h-11 items-center gap-1 self-start text-base font-semibold text-ih-primary-text focus-visible:outline-none focus-visible:shadow-ih-focus"
        onClick={onBack}
      >
        <span aria-hidden="true">&lsaquo;</span>
        <span>Work list</span>
      </button>
      <h1 ref={heading} tabIndex={-1} className="font-ih-display text-2xl font-bold tracking-tight text-ih-fg-1 focus-visible:outline-none">
        Settings
      </h1>
      <SyncSection services={services} stack={stack} canSync={policy.canSync} />
      <DeviceSection services={services} origin={origin} waiting={waiting} locale={language} />
      <NotificationsSection services={services} />
      {stack !== null && <UnreferencedPhotosSection store={stack.store} reconciler={stack.mediaReconciler} />}
      <Section title="Your data">
        <Button variant="secondary" onClick={onExport}>
          Export unsent data
        </Button>
        <ClearLocalDataControl services={services} origin={origin} onCleared={onCleared} onWiping={onWiping} />
      </Section>
      <Section title="Account">
        <SignOutControl services={services} origin={origin} onSignedOut={onSignedOut} />
        {accountUrl !== null && <ExternalLink services={services} url={accountUrl} label="Delete account" showHost />}
      </Section>
      {desktop !== undefined && <DesktopSettings desktop={desktop} />}
      <AboutSection services={services} locale={language} />
    </Screen>
  );
}
