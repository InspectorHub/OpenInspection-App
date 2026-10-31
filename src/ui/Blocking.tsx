import { SCHEMA_DRIFT_MESSAGE } from '../platform/schema';
import type { DesktopBridge, OpenReason } from '../../electron/shared/ipc-contract.ts';
import { useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { Body, Button, Heading, Notice, Screen } from './kit';

export function Booting() {
  return (
    <Screen>
      <p role="status" className="text-base text-ih-fg-2">
        Opening InspectorHub
      </p>
    </Screen>
  );
}

/** The database on this device was written by a newer app. Opening it with this one could damage it. */
export function SchemaTooNew() {
  return (
    <Screen>
      <Heading>This app is older than your data</Heading>
      <Body>The data on this device was saved by a newer version of InspectorHub. Update the app to open it. Nothing has been changed or deleted.</Body>
      <Notice tone="info">Exporting the data from this device is not available yet.</Notice>
    </Screen>
  );
}

/** A development device installed an earlier build of the local database. Not reachable on a device that never had one. */
export function SchemaDrift() {
  return (
    <Screen>
      <Heading>Local database is out of date</Heading>
      <Body>{SCHEMA_DRIFT_MESSAGE}</Body>
    </Screen>
  );
}

/** Android and iOS have no desktop bridge: they keep the plain message, and no control that only works on a desktop. */
export function OpenFailed({ reason }: { reason?: OpenReason }) {
  // Read the preload's bridge directly: its version was checked when the desktop entry started, and importing the checker
  // here would put a desktop-only module in the Android and iOS bundles.
  const bridge = typeof window === 'undefined' ? undefined : window.oiDesktop;
  if (bridge === undefined) {
    return (
      <Screen>
        <Heading>InspectorHub could not open</Heading>
        <Body>The app could not open its storage on this device. Close the app and open it again. Your data has not been changed.</Body>
      </Screen>
    );
  }
  return <DesktopOpenFailed reason={reason} bridge={bridge} />;
}

function DesktopOpenFailed({ reason, bridge }: { reason?: OpenReason; bridge: DesktopBridge }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const isUnreadable = reason === 'key-unreadable';
  const copy = reason === 'key-unreadable'
    ? 'This Windows account cannot unlock the data stored on this computer'
    : reason === 'encryption-unavailable'
      ? 'Database encryption is unavailable on this computer. Your data has not been changed.'
      : reason === 'corrupt'
        ? 'The local data could not be read. Your data has not been changed.'
        : 'InspectorHub could not open its local data. Your data has not been changed.';
  const quit = (): void => { window.close(); };
  const openDataFolder = (): void => {
    try { void bridge.shell.openDataFolder().catch(() => setMessage('The data folder could not be opened. You can quit and try again later.')); }
    catch { setMessage('The data folder could not be opened. You can quit and try again later.'); }
  };
  const setAside = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await bridge.db.setAsideUnreadable();
      window.location.reload();
    } catch {
      setBusy(false);
      setMessage('The old data could not be moved. It has not been deleted.');
    }
  };
  return (
    <Screen>
      <Heading>{isUnreadable ? 'Your existing data is locked' : 'InspectorHub could not open'}</Heading>
      <Body>{copy}</Body>
      {isUnreadable && <Body>Set the old data aside to create a new local database. The existing files will be kept on this computer.</Body>}
      {message && <Notice tone="bad">{message}</Notice>}
      <div className="flex flex-col gap-3">
        <Button onClick={quit}>Quit</Button>
        {isUnreadable
          ? <Button variant="danger" onClick={() => setConfirming(true)}>Set the old data aside and start fresh</Button>
          : <Button variant="secondary" onClick={openDataFolder}>Open data folder</Button>}
      </div>
      {confirming && (
        <ConfirmDialog
          title="Set the old data aside?"
          description="InspectorHub will move the existing local data files into a new unreadable folder. It will not delete them. The app will then start with a new empty database."
          confirmLabel="Set old data aside"
          cancelLabel="Cancel"
          destructive
          busy={busy}
          error={message}
          onConfirm={() => { void setAside(); }}
          onCancel={() => { if (!busy) setConfirming(false); }}
        />
      )}
    </Screen>
  );
}
