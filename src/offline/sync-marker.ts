import type { Db } from '../platform/db';

/** The longest document name a marker is kept for; matches the inspection id bound plus any suffix the connector adds. */
export const MAX_DOC_NAME_LENGTH = 200;
/** A state vector is a few bytes per editing client; anything beyond this is not one. */
export const MAX_COVERED_STATE_BYTES = 1_048_576;

export interface SyncMarker {
  /** The Yjs state vector the server acknowledged. */
  coveredState: Uint8Array;
  updatedAt: number;
}

function assertDocName(docName: string): void {
  if (docName.length === 0 || docName.length > MAX_DOC_NAME_LENGTH) throw new Error('Invalid sync marker document name');
}

/**
 * The synced-state marker of one document, or null when none was ever written.
 *
 * No marker means "the server may not have this document's updates": whoever decides whether local data is
 * safe to remove must treat it as unsent. A marker is written only by the collab connector, after the server
 * answered a sync step 2 (or acknowledged an update), and never optimistically.
 */
export async function readSyncMarker(db: Db, docName: string): Promise<SyncMarker | null> {
  assertDocName(docName);
  const rows = await db.query<{ covered_state: Uint8Array | null; updated_at: number }>('SELECT covered_state, updated_at FROM ydoc_sync WHERE doc_name = ?', [docName]);
  const row = rows[0];
  if (row === undefined || !(row.covered_state instanceof Uint8Array)) return null;
  return { coveredState: row.covered_state, updatedAt: row.updated_at };
}

/** Records that the server acknowledged `coveredState` for `docName`, replacing any earlier marker. */
export async function writeSyncMarker(db: Db, docName: string, coveredState: Uint8Array, now: number): Promise<void> {
  assertDocName(docName);
  if (coveredState.byteLength === 0 || coveredState.byteLength > MAX_COVERED_STATE_BYTES) throw new Error('Invalid sync marker state');
  await db.run(
    'INSERT INTO ydoc_sync (doc_name, covered_state, updated_at) VALUES (?, ?, ?) ON CONFLICT(doc_name) DO UPDATE SET covered_state = excluded.covered_state, updated_at = excluded.updated_at',
    [docName, coveredState, now],
  );
}
