import { clientPolicy, factsFor } from '../app/client-state';
import type { AppServices } from '../app/compose';
import { useClientState } from '../app/use-client-state';
import { useExpiryNotice } from './BuildExpiry';
import { ReconcileUnsupported } from './ReconcileUnsupported';
import { ServerTooOld } from './ServerTooOld';
import { TestflightExpiry } from './TestflightExpiry';
import { UpdateRecommended } from './UpdateRecommended';
import { UpgradeRequired } from './UpgradeRequired';

export interface ClientNoticesProps {
  services: AppServices;
  /** The server this session belongs to. Facts about any other server are ignored. */
  origin: string;
  locale?: string;
}

/**
 * What the client has learned about the server and about its own build, as the notices above the work. Renders nothing when there
 * is none. These panels have second-level headings: put this component after the screen's own first-level heading.
 */
export function ClientNotices({ services, origin, locale }: ClientNoticesProps) {
  const state = useClientState(services.clientState);
  const expiry = useExpiryNotice(services);
  const facts = factsFor(state, origin);
  const policy = clientPolicy(state, origin);
  const showUpdateRequired = !policy.canEdit;
  const showServerTooOld = !policy.canSync;
  const showRecommended = facts.bannerVisible && policy.canEdit;
  const showReconcile = facts.reconcileNoticeVisible;
  if (!showUpdateRequired && !showServerTooOld && !showRecommended && !showReconcile && expiry === null) return null;
  return (
    <div className="flex flex-col gap-3">
      {showUpdateRequired && <UpgradeRequired platform={services.platform} downloadUrl={facts.downloadUrl} openExternal={services.openExternal} />}
      {showServerTooOld && <ServerTooOld />}
      {showRecommended && <UpdateRecommended platform={services.platform} downloadUrl={facts.downloadUrl} openExternal={services.openExternal} onDismiss={() => services.clientState.dismissBanner(origin)} />}
      {expiry !== null && <TestflightExpiry notice={expiry} {...(locale === undefined ? {} : { locale })} />}
      {showReconcile && <ReconcileUnsupported onDismiss={() => services.clientState.dismissReconcileNotice(origin)} />}
    </div>
  );
}
