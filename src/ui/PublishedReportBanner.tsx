import type { ReportLock } from '../field/editor-data';
import { Button, Notice } from './kit';

export const PUBLISHED_TEXT = (version: number | null): string =>
  version === null
    ? 'Published. It cannot change until you choose Edit and republish.'
    : `Published as version ${String(version)}. It cannot change until you choose Edit and republish.`;

export const PUBLISHED_ELSEWHERE_TEXT = 'This report was published from another device, so edits here would be refused. Choose Edit and republish to continue.';

export const EDITING_AGAIN_TEXT = (version: number | null): string =>
  version === null
    ? 'Editing again. Clients still see the last published version until you publish the update.'
    : `Editing again. Clients still see version ${String(version)} until you publish the update.`;

export const EDIT_AND_REPUBLISH_LABEL = 'Edit and republish';
export const PUBLISH_UPDATE_LABEL = 'Publish update';
export const OFFLINE_REOPEN_TEXT = 'Connect to the internet to edit a published report.';

export interface PublishedReportBannerProps {
  lock: ReportLock;
  /** The live document was closed by the server because the report was published while this editor was open. */
  serverLocked: boolean;
  online: boolean;
  /** The "Edit and republish" request is in flight. */
  busy: boolean;
  /** A sentence about the last attempt to open the report for editing, or null. */
  error: string | null;
  onEditAgain(): void;
  onPublish(): void;
}

/**
 * What the person needs to know about a report that went out. A published report opens for reading only: nothing in it can be
 * changed until "Edit and republish", which only the server can grant, so it needs a connection. Once it is open again the
 * editor is editable and says that clients still see the last version until the update is published.
 */
export function PublishedReportBanner({ lock, serverLocked, online, busy, error, onEditAgain, onPublish }: PublishedReportBannerProps) {
  const locked = lock.contentLocked || serverLocked;
  if (!locked && !lock.editingAgain) return error === null ? null : <Notice tone="bad">{error}</Notice>;
  return (
    <div className="flex flex-col gap-2 px-4 pt-2">
      <Notice tone="watch">
        {locked ? (lock.contentLocked ? PUBLISHED_TEXT(lock.publishedVersionNumber) : PUBLISHED_ELSEWHERE_TEXT) : EDITING_AGAIN_TEXT(lock.publishedVersionNumber)}
      </Notice>
      {locked ? (
        <>
          <Button variant="secondary" busy={busy} disabled={!online} onClick={onEditAgain}>
            {EDIT_AND_REPUBLISH_LABEL}
          </Button>
          {!online && <Notice tone="watch">{OFFLINE_REOPEN_TEXT}</Notice>}
        </>
      ) : (
        <Button variant="secondary" onClick={onPublish}>
          {PUBLISH_UPDATE_LABEL}
        </Button>
      )}
      {error !== null && <Notice tone="bad">{error}</Notice>}
    </div>
  );
}
