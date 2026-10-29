import { useId, useState } from 'react';
import type { ClientPlatform } from '../app/compose';
import type { DesktopSettingsPort } from '../desktop/updater-port';
import { Button, Panel, PanelHeading } from './kit';
import { useUpdateLink } from './update-link';

export interface UpdateRecommendedProps {
  platform: ClientPlatform;
  downloadUrl: string | null;
  openExternal(url: string): Promise<void> | void;
  onDismiss(): void;
  desktop?: DesktopSettingsPort;
}

/** A newer version exists. Nothing is switched off; the banner can be closed and then stays closed for this version. */
export function UpdateRecommended({ platform, downloadUrl, openExternal, onDismiss, desktop }: UpdateRecommendedProps) {
  const titleId = useId();
  const link = useUpdateLink(downloadUrl, openExternal);
  const [blocked, setBlocked] = useState(false);
  const [restartFailed, setRestartFailed] = useState(false);
  const state = desktop?.updater;
  const canUseUpdater = platform === 'windows' && desktop?.downloadUpdate !== undefined && desktop.installAndRestart !== undefined && state !== undefined;
  const updaterButton = canUseUpdater && (state.kind === 'available' || state.kind === 'ready' || state.kind === 'downloading' || state.kind === 'checking');
  const restart = async (): Promise<void> => {
    try { setBlocked(await desktop!.installAndRestart!() === 'blocked-uploads'); setRestartFailed(false); }
    catch { setRestartFailed(true); }
  };
  return (
    <Panel tone="info" role="status" titleId={titleId}>
      <PanelHeading id={titleId}>Update available</PanelHeading>
      <p className="text-sm leading-relaxed">A newer version of the app is available.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {updaterButton ? (
          <Button variant="secondary" disabled={state.kind === 'downloading' || state.kind === 'checking'} onClick={state.kind === 'ready' ? () => { void restart(); } : () => desktop!.downloadUpdate!()}>
            {state.kind === 'ready' ? 'Restart to update' : state.kind === 'downloading' ? `Downloading update (${Math.round(state.percent)}%)` : state.kind === 'checking' ? 'Checking for updates…' : 'Download update'}
          </Button>
        ) : link.href !== null ? (
          <Button variant="secondary" onClick={link.open}>
            {platform === 'ios' ? 'Open TestFlight' : platform === 'windows' ? 'Download update' : 'Update'}
          </Button>
        ) : null}
        <Button variant="quiet" aria-label="Dismiss update notice" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      {blocked && <p role="status" className="text-sm leading-relaxed">Finish uploading before restarting to update.</p>}
      {restartFailed && <p role="alert" className="text-sm leading-relaxed">The update could not be installed. Try again.</p>}
    </Panel>
  );
}
