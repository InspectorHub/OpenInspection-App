import { useId } from 'react';
import type { ClientPlatform } from '../app/compose';
import { Body, Button, Panel, PanelHeading } from './kit';
import { useUpdateLink } from './update-link';

export interface UpgradeRequiredProps {
  platform: ClientPlatform;
  /** The server's update address (untrusted). */
  downloadUrl: string | null;
  openExternal(url: string): Promise<void> | void;
}

/**
 * The server will not accept this app version for editing. Editing is off; what is already on the device stays, keeps uploading and
 * can still be looked at. Shown above the work list, which stays usable.
 */
export function UpgradeRequired({ platform, downloadUrl, openExternal }: UpgradeRequiredProps) {
  const titleId = useId();
  const link = useUpdateLink(downloadUrl, openExternal);
  const ios = platform === 'ios';
  return (
    <Panel tone="bad" role="alert" titleId={titleId}>
      <PanelHeading id={titleId}>Update required</PanelHeading>
      <Body>This version of the app is no longer accepted by your server, so editing is turned off. Everything saved on this device stays here and keeps uploading.</Body>
      {link.href !== null ? (
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
    </Panel>
  );
}
