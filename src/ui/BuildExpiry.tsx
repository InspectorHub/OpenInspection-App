import { useEffect, useState } from 'react';
import type { AppServices } from '../app/compose';
import { useClientState } from '../app/use-client-state';
import { anchoredNow, testflightExpiryNotice, type ExpiryNotice } from '../platform/testflight-expiry';
import { TestflightExpiry } from './TestflightExpiry';

/**
 * The expiry of an iOS test build, judged on the offline lock's own time reference. Re-judged after every compat attempt (which
 * the app makes when a session starts and when it returns to the foreground), never on a timer.
 */
export function useExpiryNotice(services: AppServices): ExpiryNotice | null {
  const attempts = useClientState(services.clientState).refreshes;
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

/** The expiry notice of this build, or nothing. For the screens that have no other client notices (lock, sign-in, server setup). */
export function BuildExpiry({ services, locale }: { services: AppServices; locale?: string }) {
  const notice = useExpiryNotice(services);
  if (notice === null) return null;
  return <TestflightExpiry notice={notice} {...(locale === undefined ? {} : { locale })} />;
}
