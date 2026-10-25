import type { StackStatus } from '../../app/offline-stack';
import { Notice } from '../kit';

/**
 * What the stack says needs a person's attention, as fixed lines. The lock is not here: a locked device shows the
 * Locked screen instead of this one.
 */
export function StatusStrip({ status }: { status: StackStatus }) {
  if (!status.auth && !status.upgrade && !status.editsNotSaved && !status.collabIssue) return null;
  return (
    <div className="flex flex-col gap-2">
      {status.editsNotSaved && <Notice tone="bad">Some edits may not be saved on this device. Free up storage and restart the app.</Notice>}
      {status.auth && <Notice tone="watch">Sign in again to keep syncing</Notice>}
      {status.upgrade && <Notice tone="watch">Update the app to keep syncing</Notice>}
      {status.collabIssue && <p className="text-sm text-ih-fg-3">Live collaboration is having trouble. Your changes are still stored on this device.</p>}
    </div>
  );
}
