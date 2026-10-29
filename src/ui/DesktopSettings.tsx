import { useId } from 'react';
import type { DesktopSettingsPort } from '../desktop/updater-port';
import { Button, Notice } from './kit';

function updaterMessage(kind: DesktopSettingsPort['updater']['kind'], state: DesktopSettingsPort['updater']): string {
  switch (kind) {
    case 'disabled': return 'Updates are turned off in this build';
    case 'idle': return 'Updates are on';
    case 'checking': return 'Checking for updates';
    case 'available': return `Version ${state.kind === 'available' ? state.version : ''} is available`;
    case 'downloading': return `Downloading update: ${state.kind === 'downloading' ? Math.round(state.percent) : 0}%`;
    case 'ready': return `Version ${state.kind === 'ready' ? state.version : ''} is ready to install`;
    case 'error': return 'Could not check for updates';
  }
}

export function DesktopSettings({ desktop }: { desktop: DesktopSettingsPort }) {
  const stateId = useId();
  const updating = desktop.updater.kind === 'checking' || desktop.updater.kind === 'downloading';
  const disabled = desktop.updater.kind === 'disabled';
  return (
    <section aria-labelledby={stateId} className="flex flex-col gap-3">
      <h2 id={stateId} className="font-ih-display text-lg font-bold tracking-tight text-ih-fg-1">Desktop app</h2>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-base">
        <dt className="text-ih-fg-3">App version</dt>
        <dd className="text-ih-fg-1">{desktop.appVersion}</dd>
      </dl>
      {disabled ? <Notice tone="info">Updates are turned off in this build</Notice> : <p role="status" aria-live="polite" className="text-base leading-relaxed text-ih-fg-2">{updaterMessage(desktop.updater.kind, desktop.updater)}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant="secondary" disabled={disabled || updating} busy={updating} onClick={desktop.checkForUpdates}>Check for updates</Button>
        <Button variant="quiet" onClick={desktop.openLogs}>Open log folder</Button>
        <Button variant="quiet" onClick={desktop.openDataFolder}>Open data folder</Button>
      </div>
      <p className="text-sm leading-relaxed text-ih-fg-3">Uploads continue only while InspectorHub is open.</p>
    </section>
  );
}
