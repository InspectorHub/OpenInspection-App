import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { AppServices } from '../app/compose';
import type { TimerPort } from '../collab/timers';
import { useOfflineStack } from '../app/stack-context';
import type { StoredIdentity } from '../auth/server-config';
import { reconcileGateFor } from '../export/reconcile-gate';
import type { Network } from '../platform/network';
import type { DesktopSettingsPort } from '../desktop/updater-port';
import type { DiagDeps } from '../dev/checks/types';
import { ClientNotices } from './ClientNotices';
import { DevDiagnostics } from './dev-diagnostics';
import { EditorBoundary } from './EditorBoundary';
import { editorModule } from './editor-loader';
import { ExportFlow } from './ExportFlow';
import { Body, Button, Heading, Screen } from './kit';
import { NotificationPrompt } from './NotificationPrompt';
import { Settings } from './Settings';
import { SignOutControl } from './SignOutControl';
import { WorkList } from './WorkList';

// The editor and its libraries are a chunk of their own: the lock, sign-in and work-list screens do not load it. The chunk is part
// of the app's assets, so opening it needs no network.
// A load that failed is cached by React, so the lazy is rebuilt when the person goes back: the next tap tries the load again.
const makeEditorScreen = () => lazy(() => editorModule.load().then((module) => ({ default: module.EditorScreen })));
let EditorScreen = makeEditorScreen();

export interface SignedInProps {
  services: AppServices;
  origin: string;
  identity: StoredIdentity;
  onSignedOut(): void;
  /** Local data is being cleared (true) or the clear failed (false); the app stops its lock checks meanwhile. */
  onWiping?(wiping: boolean): void;
  /** Timers of the polling reads (the upload count). Defaults to the real ones. */
  timers?: TimerPort;
  /** Link state for the editor. Defaults to the device's. */
  network?: Network;
  desktopSettings?: DesktopSettingsPort;
  diagnostics?: DiagDeps;
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  inspector: 'Inspector',
};

const UNKNOWN_ROLE_LABEL = 'Team member';

/** The role is server-supplied text; only a fixed label of ours ever reaches the screen. */
export function roleLabel(role: string): string {
  return Object.hasOwn(ROLE_LABELS, role) ? (ROLE_LABELS[role] ?? UNKNOWN_ROLE_LABEL) : UNKNOWN_ROLE_LABEL;
}

/** The home of a signed-in device: the work list (where there is an offline stack), the account, and the sign-out contract. */
export function SignedIn({ services, origin, identity, onSignedOut, onWiping, timers, network, desktopSettings, diagnostics }: SignedInProps) {
  const [view, setView] = useState<'home' | 'settings'>('home');
  // The inspection open in the editor, or null for the work list.
  const [editing, setEditing] = useState<string | null>(null);
  // What the open export covers: everything (an empty object) or the listed inspections (a quarantined row's own export).
  const [exporting, setExporting] = useState<{ only?: readonly string[] } | null>(null);
  const [exportsClosed, setExportsClosed] = useState(0);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const leftSettings = useRef(false);
  const stack = useOfflineStack();
  const reconcile = useMemo(() => (stack === null ? undefined : reconcileGateFor(stack.reconciler)), [stack]);
  // After the first-level heading: the notices have second-level ones.
  const notices = <ClientNotices services={services} origin={origin} />;

  // Back from Settings lands on the button that opened it.
  useEffect(() => {
    if (view === 'home' && leftSettings.current) {
      leftSettings.current = false;
      settingsTrigger.current?.focus();
    }
  }, [view]);

  function closeSettings(): void {
    leftSettings.current = true;
    setView('home');
  }

  const exportFlow = exporting !== null && (
    <ExportFlow
      services={services}
      reconcile={reconcile}
      only={exporting.only}
      onClose={() => {
        setExporting(null);
        setExportsClosed((n) => n + 1);
      }}
    />
  );
  const prompt = <NotificationPrompt services={services} exportsClosed={exportsClosed} suspended={exporting !== null} timers={timers} />;

  if (editing !== null && stack !== null) {
    const back = (): void => {
      EditorScreen = makeEditorScreen();
      setEditing(null);
    };
    return (
      <EditorBoundary onBack={back}>
      <Suspense
        fallback={
          <Screen>
            <div role="status" aria-busy="true">
              <Body>Opening the inspection…</Body>
            </div>
          </Screen>
        }
      >
        <EditorScreen services={services} stack={stack} origin={origin} inspectionId={editing} onExit={back} {...(network === undefined ? {} : { network })} />
      </Suspense>
      </EditorBoundary>
    );
  }

  if (view === 'settings') {
    return (
      <>
        <Settings
          services={services}
          origin={origin}
          stack={stack}
          onBack={closeSettings}
          onExport={() => setExporting({})}
          onSignedOut={onSignedOut}
          onCleared={onSignedOut}
          onWiping={onWiping}
          timers={timers}
          desktop={desktopSettings}
        />
        {exportFlow}
        {prompt}
      </>
    );
  }

  return (
    <Screen wide={stack !== null}>
      {stack === null ? (
        <>
          <Heading>Work list</Heading>
          {notices}
          <Button variant="secondary" onClick={() => setExporting({})}>
            Export unsent data
          </Button>
        </>
      ) : (
        <WorkList stack={stack} notices={notices} onOpenInspection={setEditing} onSettings={() => setView('settings')} settingsRef={settingsTrigger} onExportAll={() => setExporting({})} onExport={(inspectionId) => setExporting({ only: [inspectionId] })} />
      )}
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-base">
        <dt className="text-ih-fg-3">Role</dt>
        <dd data-testid="identity-role" className="text-ih-fg-1">
          {roleLabel(identity.role)}
        </dd>
        <dt className="text-ih-fg-3">Server</dt>
        <dd className="break-all font-ih-mono text-sm text-ih-fg-1">{origin}</dd>
      </dl>
      <Body>Signing out removes your sign-in from this device. Inspections, photos and anything not yet uploaded stay on the device.</Body>
      {stack === null && (
        <Button ref={settingsTrigger} variant="secondary" onClick={() => setView('settings')}>
          Settings
        </Button>
      )}
      <SignOutControl services={services} origin={origin} onSignedOut={onSignedOut} />
      <DevDiagnostics services={services} origin={origin} deps={diagnostics} />
      {exportFlow}
      {prompt}
    </Screen>
  );
}
