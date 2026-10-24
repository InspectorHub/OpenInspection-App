import type { Db } from '../platform/db';

/**
 * How many things on this device have not reached the server: media still to upload (queued, in
 * flight, or failed) plus queued write operations (waiting, or failed and holding the queue).
 *
 * Outbox rows in the `orphaned` state are not counted yet: the queue task decides how they are
 * shown. Extend the two state lists here when that lands, so every screen counts the same way.
 */
export async function countWaitingUploads(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>(
    `SELECT
       (SELECT COUNT(*) FROM media WHERE state IN ('pending', 'uploading', 'failed'))
       + (SELECT COUNT(*) FROM outbox WHERE state IN ('pending', 'failed')) AS n`,
  );
  return rows[0]?.n ?? 0;
}
