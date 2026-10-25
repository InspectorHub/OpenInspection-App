import type { Db } from '../platform/db';
import { countOrphanedOutbox, countWaitingUploads } from './waiting';

/** What clearing this device would destroy for good because the server does not have it. */
export interface AtRisk {
  /** Photos, clips and queued changes still to upload. */
  waiting: number;
  /** Queued changes whose inspection is gone or no longer yours; they will never be sent. */
  orphaned: number;
  /** Inspections created on this device that the server has not confirmed. */
  createdHere: number;
  total: number;
}

export async function countAtRisk(db: Db): Promise<AtRisk> {
  const waiting = await countWaitingUploads(db);
  const orphaned = await countOrphanedOutbox(db);
  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM work_package WHERE server_confirmed <> 1');
  const createdHere = Number(rows[0]?.n ?? 0);
  return { waiting, orphaned, createdHere, total: waiting + orphaned + createdHere };
}
