import { useId } from 'react';
import type { ClientPlatform } from '../app/compose';
import { Button, Panel, PanelHeading } from './kit';
import { useUpdateLink } from './update-link';

export interface UpdateRecommendedProps {
  platform: ClientPlatform;
  downloadUrl: string | null;
  openExternal(url: string): Promise<void> | void;
  onDismiss(): void;
}

/** A newer version exists. Nothing is switched off; the banner can be closed and then stays closed for this version. */
export function UpdateRecommended({ platform, downloadUrl, openExternal, onDismiss }: UpdateRecommendedProps) {
  const titleId = useId();
  const link = useUpdateLink(downloadUrl, openExternal);
  return (
    <Panel tone="info" role="status" titleId={titleId}>
      <PanelHeading id={titleId}>Update available</PanelHeading>
      <p className="text-sm leading-relaxed">A newer version of the app is available.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {link.href !== null && (
          <Button variant="secondary" onClick={link.open}>
            {platform === 'ios' ? 'Open TestFlight' : 'Update'}
          </Button>
        )}
        <Button variant="quiet" aria-label="Dismiss update notice" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </Panel>
  );
}
