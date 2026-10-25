import { useId } from 'react';
import { Panel, PanelHeading } from './kit';

/** The server speaks an older contract than this app needs. Local work goes on; nothing syncs until the server is updated. */
export function ServerTooOld() {
  const titleId = useId();
  return (
    <Panel tone="watch" role="status" titleId={titleId}>
      <PanelHeading id={titleId}>Server version too old</PanelHeading>
      <p className="text-sm leading-relaxed">Contact your administrator. You can keep working on this device, but your changes will not sync until the server is updated.</p>
    </Panel>
  );
}
