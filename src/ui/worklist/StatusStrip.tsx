import type { StackStatus } from '../../app/offline-stack';
import { Button, Notice } from '../kit';
import { EDITS_NOT_SAVED_TEXT, SERVER_UNREACHABLE_TEXT, SYNC_PAUSED_TEXT } from './copy';

/**
 * The grey line about the server contact, or null. A real revocation (the amber sign-in line) wins over it: a person who has to
 * sign in again is not also told the server is out of reach. The unreachable line only shows while the device has a network
 * (`online` unknown counts as having one): with none, the connection chip already says why nothing reaches the server.
 */
function serverLine(status: StackStatus, online: boolean | null): string | null {
  if (status.auth) return null;
  if (status.serverUnreachable && online !== false) return SERVER_UNREACHABLE_TEXT;
  if (status.syncPaused && !status.serverUnreachable) return SYNC_PAUSED_TEXT;
  return null;
}

/**
 * What the stack says needs a person's attention, as fixed lines. The lock is not here: a locked device shows the
 * Locked screen instead of this one. A server that wants a newer app is not here either: `ClientNotices` owns that, from the
 * server's own answer, so there is one panel and no second line that could outlive it.
 *
 * The grey line sits in a live region that is always in the page and only has its text swapped, because a region that is
 * inserted already holding text is not announced by some screen readers. Empty, it is visually hidden and out of the layout.
 */
export function StatusStrip({ status, online, onSignInAgain }: { status: StackStatus; online: boolean | null; onSignInAgain?: () => void }) {
  const line = serverLine(status, online);
  const notices = status.auth || status.editsNotSaved || status.collabIssue;
  return (
    <>
      {notices && (
        <div className="flex flex-col gap-2">
          {status.editsNotSaved && <Notice tone="bad">{EDITS_NOT_SAVED_TEXT}</Notice>}
          {status.auth && (
            <Notice tone="watch">
              <div className="flex flex-col items-start gap-2">
                <span>Sign in again to keep syncing</span>
                {/* Only a screen change: the sign-in screen it opens does the work, and a second tap in the same frame sets the same screen. */}
                {onSignInAgain !== undefined && (
                  <Button variant="secondary" onClick={onSignInAgain}>
                    Sign in again
                  </Button>
                )}
              </div>
            </Notice>
          )}
          {status.collabIssue && <p className="text-sm text-ih-fg-3">Live collaboration is having trouble. Your changes are still stored on this device.</p>}
        </div>
      )}
      <p role="status" data-testid="server-line" className={line === null ? 'sr-only' : 'text-sm text-ih-fg-3'}>
        {line}
      </p>
    </>
  );
}
