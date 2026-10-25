import type { StackStatus } from '../../app/offline-stack';
import { Notice } from '../kit';
import { SERVER_UNREACHABLE_TEXT } from './copy';

/**
 * What the stack says needs a person's attention, as fixed lines. The lock is not here: a locked device shows the
 * Locked screen instead of this one. A server that wants a newer app is not here either: `ClientNotices` owns that, from the
 * server's own answer, so there is one panel and no second line that could outlive it.
 */
export function StatusStrip({ status, online }: { status: StackStatus; online: boolean | null }) {
  // Only while the device has a network: with none, the connection chip already says why nothing reaches the server.
  const unreachable = status.serverUnreachable && online !== false;
  if (!status.auth && !status.editsNotSaved && !status.collabIssue && !unreachable) return null;
  return (
    <div className="flex flex-col gap-2">
      {status.editsNotSaved && <Notice tone="bad">Some edits may not be saved on this device. Free up storage and restart the app.</Notice>}
      {status.auth && <Notice tone="watch">Sign in again to keep syncing</Notice>}
      {unreachable && <p role="status" className="text-sm text-ih-fg-3">{SERVER_UNREACHABLE_TEXT}</p>}
      {status.collabIssue && <p className="text-sm text-ih-fg-3">Live collaboration is having trouble. Your changes are still stored on this device.</p>}
    </div>
  );
}
