import { useEffect, useState } from 'react';
import { clientPolicy } from '../app/client-state';
import type { AppServices } from '../app/compose';
import { useClientState } from '../app/use-client-state';
import { anchoredNow, testflightExpiryNotice, type ExpiryNotice } from '../platform/testflight-expiry';
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
 * The expiry of an iOS test build, judged on the offline lock's own time reference. Re-judged after every compat attempt (which
 * the app makes when a session starts and when it returns to the foreground), never on a timer.
 */
function useExpiry(services: AppServices, attempts: number): ExpiryNotice | null {
  const [notice, setNotice] = useState<ExpiryNotice | null>(null);
  const { db, clock, platform, builtAt } = services;
  useEffect(() => {
    let current = true;
    void anchoredNow(db, clock).then((now) => {
      if (current) setNotice(testflightExpiryNotice({ platform, builtAt, now }));
    });
    return () => {
      current = false;
    };
  }, [db, clock, platform, builtAt, attempts]);
  return notice;
}

/** What the client has learned about the server and about its own build, as the notices above the work. Renders nothing when there is none. */
export function ClientNotices({ services, origin, locale }: ClientNoticesProps) {
  const state = useClientState(services.clientState);
  const expiry = useExpiry(services, state.refreshes);
  const mine = state.origin === origin;
  const policy = clientPolicy(state, origin);
  const showUpdateRequired = mine && !policy.canEdit;
  const showServerTooOld = mine && !policy.canSync;
  const showRecommended = mine && state.bannerVisible && policy.canEdit;
  if (!showUpdateRequired && !showServerTooOld && !showRecommended && expiry === null) return null;
  return (
    <div className="flex flex-col gap-3">
      {showUpdateRequired && <UpgradeRequired platform={services.platform} downloadUrl={state.downloadUrl} openExternal={services.openExternal} />}
      {showServerTooOld && <ServerTooOld />}
      {showRecommended && <UpdateRecommended platform={services.platform} downloadUrl={state.downloadUrl} openExternal={services.openExternal} onDismiss={services.clientState.dismissBanner} />}
      {expiry !== null && <TestflightExpiry notice={expiry} {...(locale === undefined ? {} : { locale })} />}
    </div>
  );
}
