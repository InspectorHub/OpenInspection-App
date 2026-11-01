import { useId } from 'react';
import { Button } from '../kit';

export const IMPORT_NEEDS_SESSION = 'Sign in to import a package.';
export const IMPORT_NEEDS_NETWORK = 'Connect to the internet to import a package.';
export const IMPORT_SERVER_TOO_OLD = 'This server is older than the app expects, so importing is unavailable until it is updated.';
export const IMPORT_NEEDS_UPDATE = 'Update the app to import a package.';

export interface ImportAvailability {
  /** An offline stack runs for this session (the account the package must belong to). */
  hasSession: boolean;
  /** Link state; null until known, which does not switch the button off. */
  online: boolean | null;
  canSync: boolean;
  canEdit: boolean;
}

/** Why importing is not possible right now, in the order a person can fix them, or null when it is. */
export function importUnavailableReason({ hasSession, online, canSync, canEdit }: ImportAvailability): string | null {
  if (!hasSession) return IMPORT_NEEDS_SESSION;
  if (online === false) return IMPORT_NEEDS_NETWORK;
  if (!canSync) return IMPORT_SERVER_TOO_OLD;
  if (!canEdit) return IMPORT_NEEDS_UPDATE;
  return null;
}

/**
 * The entry to importing a package, next to the export. It is never hidden: when it cannot be used it is marked unavailable (still
 * focusable, so a screen reader finds it, with the reason linked to it and its click ignored) and the reason sits beside it.
 */
export function ImportEntry({ availability, onImport }: { availability: ImportAvailability; onImport(): void }) {
  const reasonId = useId();
  const reason = importUnavailableReason(availability);
  return (
    <>
      <Button
        variant="secondary"
        aria-disabled={reason === null ? undefined : true}
        aria-describedby={reason === null ? undefined : reasonId}
        className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
        onClick={reason === null ? onImport : undefined}
      >
        Import package
      </Button>
      {reason !== null && (
        <p id={reasonId} className="text-base leading-relaxed text-ih-fg-2">
          {reason}
        </p>
      )}
    </>
  );
}
