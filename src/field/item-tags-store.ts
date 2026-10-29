import type { Db } from '../platform/db';

/**
 * The tags a person put on checklist items, kept on the device (`item_tags`). A row is one tag on one item, and its
 * `state` says what the server knows:
 *  - `synced`: the server has it.
 *  - `add`: the person added it and the server has not been told yet.
 *  - `remove`: the person removed it and the server has not been told yet. The row stays so the removal can be sent.
 *
 * Adding and removing a tag are independent of every other write and repeating either changes nothing, so this is a
 * set of rows with a state, not a queue: nothing here has an order, and a row that can never be sent is dropped without
 * holding anything else back (the outbox is the opposite: one stuck head holds back its whole inspection).
 *
 * Every function takes the account key (`accountKey(account)`), so two accounts on one device never see each other's rows.
 */

export type TagState = 'synced' | 'add' | 'remove';

export interface TagInfo {
  id: string;
  name: string;
  color?: string;
}

/** What the editor shows: the tags on each item, by item id. Same shape as `ItemTagMap` of the editor package. */
export type TagMap = Record<string, TagInfo[]>;

export interface TagRow {
  inspectionId: string;
  itemId: string;
  tagId: string;
  name: string;
  color: string | null;
  state: TagState;
  updatedAt: number;
}

interface RawRow {
  inspection_id: string;
  item_id: string;
  tag_id: string;
  name: string;
  color: string | null;
  state: string;
  updated_at: number;
}

const STATES: readonly string[] = ['synced', 'add', 'remove'];

function toRow(raw: RawRow): TagRow {
  // A row written by something else is not trusted: an unknown state would otherwise be sent as if it were an add.
  if (!STATES.includes(raw.state)) throw new Error('item_tags holds an unknown state');
  return {
    inspectionId: raw.inspection_id,
    itemId: raw.item_id,
    tagId: raw.tag_id,
    name: raw.name,
    color: raw.color,
    state: raw.state as TagState,
    updatedAt: raw.updated_at,
  };
}

const COLUMNS = 'inspection_id, item_id, tag_id, name, color, state, updated_at';
const KEY = 'account_key = ? AND inspection_id = ? AND item_id = ? AND tag_id = ?';

/** The tags to show: every row that is not waiting to be removed. */
export async function readTags(db: Db, account: string, inspectionId: string): Promise<TagMap> {
  const rows = await db.query<RawRow>(
    `SELECT ${COLUMNS} FROM item_tags WHERE account_key = ? AND inspection_id = ? AND state <> 'remove' ORDER BY item_id, updated_at, tag_id`,
    [account, inspectionId],
  );
  const map: TagMap = {};
  for (const raw of rows) {
    const row = toRow(raw);
    (map[row.itemId] ??= []).push({ id: row.tagId, name: row.name, ...(row.color === null ? {} : { color: row.color }) });
  }
  return map;
}

/** The person put this tag on the item. A removal that was still waiting is simply cancelled. */
export async function addTag(db: Db, account: string, inspectionId: string, itemId: string, tag: TagInfo, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    const key = [account, inspectionId, itemId, tag.id];
    const found = await tx.query<RawRow>(`SELECT ${COLUMNS} FROM item_tags WHERE ${KEY}`, key);
    if (found.length === 0) {
      await tx.run('INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        ...key,
        tag.name,
        tag.color ?? null,
        'add',
        now,
      ]);
      return;
    }
    // Only a waiting removal changes: the server still has the tag, so it is back to what the server has.
    await tx.run(`UPDATE item_tags SET state = 'synced', updated_at = ? WHERE ${KEY} AND state = 'remove'`, [now, ...key]);
  });
}

/**
 * The person took this tag off the item. A tag the server was never told about is just forgotten; one the server has
 * stays as a row marked `remove` until the server has been told.
 */
export async function removeTag(db: Db, account: string, inspectionId: string, itemId: string, tagId: string, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    const key = [account, inspectionId, itemId, tagId];
    await tx.run(`DELETE FROM item_tags WHERE ${KEY} AND state = 'add'`, key);
    await tx.run(`UPDATE item_tags SET state = 'remove', updated_at = ? WHERE ${KEY} AND state = 'synced'`, [now, ...key]);
  });
}

/** The rows the server has still to hear about, oldest first. One inspection, or (omitted) every inspection of the account. */
export async function pendingTags(db: Db, account: string, inspectionId?: string): Promise<TagRow[]> {
  const rows = await db.query<RawRow>(
    `SELECT ${COLUMNS} FROM item_tags WHERE account_key = ? AND state <> 'synced'${inspectionId === undefined ? '' : ' AND inspection_id = ?'} ORDER BY updated_at, inspection_id, item_id, tag_id`,
    inspectionId === undefined ? [account] : [account, inspectionId],
  );
  return rows.map(toRow);
}

/**
 * The server took the change. Only a row that is STILL in the state that was sent is settled: if the person changed
 * their mind while the request was out, the row is no longer in that state and is left for the next round.
 */
export async function settleSent(db: Db, account: string, row: TagRow): Promise<void> {
  const key = [account, row.inspectionId, row.itemId, row.tagId];
  if (row.state === 'add') await db.run(`UPDATE item_tags SET state = 'synced' WHERE ${KEY} AND state = 'add'`, key);
  else if (row.state === 'remove') await db.run(`DELETE FROM item_tags WHERE ${KEY} AND state = 'remove'`, key);
}

/**
 * The server will never take the change (the tag was deleted, the item or inspection is gone, the person may not
 * edit). The row is dropped so it is not sent again: an add that was refused is undone, and a removal that was refused
 * is forgotten (the next read from the server shows what is really there).
 */
export async function dropRejected(db: Db, account: string, row: TagRow): Promise<void> {
  const key = [account, row.inspectionId, row.itemId, row.tagId];
  await db.run(`DELETE FROM item_tags WHERE ${KEY} AND state = ?`, [...key, row.state]);
}

/**
 * Brings the rows in line with what the server answered for the inspection, without losing what it has not heard yet:
 * a pending add is kept, a pending removal wins over the server still having the tag, a tag the server has and the
 * device does not is added as `synced`, and a `synced` row the server no longer has is dropped (removed elsewhere).
 */
export async function mergeFromServer(db: Db, account: string, inspectionId: string, server: TagMap, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    const local = (await tx.query<RawRow>(`SELECT ${COLUMNS} FROM item_tags WHERE account_key = ? AND inspection_id = ?`, [account, inspectionId])).map(toRow);
    const have = new Map(local.map((row) => [`${row.itemId}\u0000${row.tagId}`, row]));
    const onServer = new Set<string>();
    for (const [itemId, tags] of Object.entries(server)) {
      for (const tag of tags) {
        const id = `${itemId}\u0000${tag.id}`;
        onServer.add(id);
        const row = have.get(id);
        if (row === undefined) {
          await tx.run('INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
            account,
            inspectionId,
            itemId,
            tag.id,
            tag.name,
            tag.color ?? null,
            'synced',
            now,
          ]);
        } else if (row.state !== 'remove') {
          // The server has it, so an 'add' is done; the server's name and colour are the current ones.
          await tx.run(`UPDATE item_tags SET state = 'synced', name = ?, color = ? WHERE ${KEY} AND state <> 'remove'`, [tag.name, tag.color ?? null, account, inspectionId, itemId, tag.id]);
        }
      }
    }
    for (const row of local) {
      if (row.state === 'synced' && !onServer.has(`${row.itemId}\u0000${row.tagId}`)) {
        await tx.run(`DELETE FROM item_tags WHERE ${KEY} AND state = 'synced'`, [account, inspectionId, row.itemId, row.tagId]);
      }
    }
  });
}

/** Every row of one inspection, whatever its state (the purge of an inspection removed from the device). */
export async function deleteInspectionTags(db: Db, account: string, inspectionId: string): Promise<void> {
  await db.run('DELETE FROM item_tags WHERE account_key = ? AND inspection_id = ?', [account, inspectionId]);
}
