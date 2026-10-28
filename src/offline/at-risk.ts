import { docIsCovered } from '../collab/sync-proof';
import type { Db } from '../platform/db';
import { countOrphanedOutbox, countWaitingUploads } from './waiting';

/** What clearing this device would destroy for good because the server does not have it. */
export interface AtRisk {
  /** Photos, clips, queued changes and tag changes still to upload. */
  waiting: number;
  /** Queued changes whose inspection is gone or no longer yours; they will never be sent. */
  orphaned: number;
  /** Inspections created on this device that the server has not confirmed. */
  createdHere: number;
  /** Inspections whose stored document holds edits the server has not been shown to have. */
  unsyncedEdits: number;
  total: number;
}

/**
 * Same rule as the export and the reconcile: a document counts as safe only when the server's own answer proves it holds every
 * stored update (`docIsCovered`). A document that cannot be read, is too large to check, or has no usable marker is NOT covered,
 * so any doubt shows up here as something to lose.
 */
async function countUnsyncedDocuments(db: Db): Promise<number> {
  const names = await db.query<{ doc_name: string }>('SELECT DISTINCT doc_name FROM ydoc_updates');
  let unsynced = 0;
  for (const { doc_name: docName } of names) {
    let covered = false;
    try {
      covered = await docIsCovered(db, docName);
    } catch {
      covered = false;
    }
    if (!covered) unsynced += 1;
  }
  return unsynced;
}

export async function countAtRisk(db: Db): Promise<AtRisk> {
  const waiting = await countWaitingUploads(db);
  const orphaned = await countOrphanedOutbox(db);
  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM work_package WHERE server_confirmed <> 1');
  const createdHere = Number(rows[0]?.n ?? 0);
  const unsyncedEdits = await countUnsyncedDocuments(db);
  return { waiting, orphaned, createdHere, unsyncedEdits, total: waiting + orphaned + createdHere + unsyncedEdits };
}
