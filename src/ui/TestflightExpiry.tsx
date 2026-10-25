import type { ExpiryNotice } from '../platform/testflight-expiry';
import { Notice } from './kit';
import { dateLabel } from './worklist/format';

/** An iOS test build stops opening 90 days after it was built; this is the warning that comes before, and the note after. */
export function TestflightExpiry({ notice, locale }: { notice: ExpiryNotice; locale?: string }) {
  const when = dateLabel(notice.expiresAt, locale);
  return <Notice tone="watch">{notice.expired ? `Test build expired on ${when}.` : `Test build expires on ${when}.`} Connect to the internet to update.</Notice>;
}
