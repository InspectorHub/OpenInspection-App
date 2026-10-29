import { writeDeviceState } from '../auth/server-config';
import { accountKey, type Account } from '../offline/outbox';
import type { Db } from '../platform/db';

/**
 * How many tag changes the server refused for good while no editor was open (a background send), per account, kept until
 * the person is told. The send undoes such a change on the device, so without this the person would never learn it was
 * undone. The editor shows the notice at once for what it sends itself; only the background count is stored here.
 *
 * One `device_state` value per account under the declared `tag_rejected:` family. A clear removes it with the rest of the
 * account's data.
 */

/** A count that could not be real is held at this: the notice only says "some". */
export const MAX_REJECTED_COUNT = 1_000_000;

const keyOf = (account: Account): string => `tag_rejected:${accountKey(account)}`;

/** A stored value that is anything but a plain non-negative integer counts as none. */
function parse(value: string | undefined): number {
  if (value === undefined || !/^\d{1,9}$/.test(value)) return 0;
  return Math.min(Number(value), MAX_REJECTED_COUNT);
}

/** Adds to the account's count. A count that is not a positive integer adds nothing. Rejects on a storage failure: callers catch. */
export async function recordRejected(db: Db, account: Account, count: number): Promise<void> {
  if (!Number.isFinite(count) || count <= 0) return;
  const add = Math.min(Math.trunc(count), MAX_REJECTED_COUNT);
  if (add <= 0) return;
  const key = keyOf(account);
  await db.transaction(async (tx) => {
    const rows = await tx.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]);
    await writeDeviceState(tx, key, String(Math.min(parse(rows[0]?.value) + add, MAX_REJECTED_COUNT)));
  });
}

/** The account's count, read and cleared together. 0 when none or unreadable. Rejects on a storage failure: callers catch. */
export async function takeRejected(db: Db, account: Account): Promise<number> {
  const key = keyOf(account);
  return db.transaction(async (tx) => {
    const rows = await tx.query<{ value: string }>('SELECT value FROM device_state WHERE key = ?', [key]);
    if (rows.length === 0) return 0;
    await tx.run('DELETE FROM device_state WHERE key = ?', [key]);
    return parse(rows[0]?.value);
  });
}
