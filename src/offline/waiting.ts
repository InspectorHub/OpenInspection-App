import type { Db } from '../platform/db';

/**
 * How many things on this device have not reached the server: media still to upload (queued, in
 * flight, or failed) plus queued write operations (waiting, or failed and holding the queue) plus tag changes the server
 * has not been told about (`item_tags` rows that are not `synced`; they are not in the queue, so they would otherwise be
 * missed here and in every warning built on this count, such as signing out or clearing the device).
 *
 * Outbox rows in the `orphaned` state are NOT counted here: their inspection is gone or no longer assigned,
 * so they are not uploadable. `countOrphanedOutbox` counts them, and a screen shows that number on its own line.
 */
export async function countWaitingUploads(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM media WHERE state IN ('pending', 'uploading', 'failed'))
       + (SELECT COUNT(*) FROM outbox WHERE state IN ('pending', 'failed'))
       + (SELECT COUNT(*) FROM item_tags WHERE state <> 'synced') AS n`,
  );
  return rows[0]?.n ?? 0;
}

/** Queued writes that will never be sent because their inspection is deleted or no longer assigned to this person. */
export async function countOrphanedOutbox(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE state = 'orphaned'");
  return rows[0]?.n ?? 0;
}
