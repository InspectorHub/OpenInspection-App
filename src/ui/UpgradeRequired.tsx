import { useId } from 'react';
import type { ClientPlatform } from '../app/compose';
import type { DesktopSettingsPort } from '../desktop/updater-port';
import { Body, Button, Panel, PanelHeading } from './kit';
import { useUpdateLink } from './update-link';
import { useState } from 'react';

export interface UpgradeRequiredProps {
  platform: ClientPlatform;
  /** The server's update address (untrusted). */
  downloadUrl: string | null;
  openExternal(url: string): Promise<void> | void;
  desktop?: DesktopSettingsPort;
}

/**
 * The server will not accept this app version for editing. Editing is off; what is already on the device stays, keeps uploading and
 * can still be looked at. Shown above the work list, which stays usable.
 */
export function UpgradeRequired({ platform, downloadUrl, openExternal, desktop }: UpgradeRequiredProps) {
  const titleId = useId();
  const link = useUpdateLink(downloadUrl, openExternal);
  const ios = platform === 'ios';
  const [blocked, setBlocked] = useState<'uploads' | 'transaction' | null>(null);
  const [restartFailed, setRestartFailed] = useState(false);
  const state = desktop?.updater;
  const canUseUpdater = platform === 'windows' && desktop?.downloadUpdate !== undefined && desktop.installAndRestart !== undefined && state !== undefined;
  const restart = async (): Promise<void> => {
    try {
      const result = await desktop!.installAndRestart!();
      setBlocked(result === 'blocked-uploads' ? 'uploads' : result === 'blocked-transaction' ? 'transaction' : null);
      setRestartFailed(false);
    }
    catch { setBlocked(null); setRestartFailed(true); }
  };
  const updaterButton = canUseUpdater && (state.kind === 'available' || state.kind === 'ready' || state.kind === 'downloading' || state.kind === 'checking');
  return (
    <Panel tone="bad" role="alert" titleId={titleId}>
      <PanelHeading id={titleId}>Update required</PanelHeading>
      <Body>This version of the app is no longer accepted by your server, so editing is turned off. Everything saved on this device stays here and keeps uploading.</Body>
      {updaterButton ? (
        <Button variant="primary" disabled={state.kind === 'downloading' || state.kind === 'checking'} onClick={state.kind === 'ready' ? () => { void restart(); } : () => desktop!.downloadUpdate!()}>
          {state.kind === 'ready' ? 'Restart to update' : state.kind === 'downloading' ? `Downloading update (${Math.round(state.percent)}%)` : state.kind === 'checking' ? 'Checking for updates…' : 'Download update'}
        </Button>
      ) : link.href !== null ? (
        <Button variant="primary" onClick={link.open}>
          {ios ? 'Open TestFlight' : 'Download update'}
        </Button>
      ) : (
        <Body>{ios ? 'Open the TestFlight app to install the latest build.' : 'Ask your administrator for the latest version of the app.'}</Body>
      )}
      {link.failed && (
        <p role="alert" className="text-sm leading-relaxed">
          The update link could not be opened. Try again, or ask your administrator.
        </p>
      )}
      {blocked === 'uploads' && <Body>Finish uploading before restarting to update.</Body>}
      {blocked === 'transaction' && <Body>Finish or cancel the current edit before restarting to update.</Body>}
      {restartFailed && <Body>The update could not be installed. Try again.</Body>}
    </Panel>
  );
}
