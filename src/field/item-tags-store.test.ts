import { describe, expect, it } from 'vitest';
import { accountKey } from '../offline/outbox';
import {
  addTag,
  deleteInspectionTags,
  dropRejected,
  mergeFromServer,
  pendingTags,
  readTags,
  removeTag,
  settleSent,
  type TagInfo,
  type TagRow,
} from './item-tags-store';
import { resourceWorld } from './test-support/resource-world';
import { ALICE, BOB } from './test-support/seed-package';

const A = accountKey(ALICE);
const B = accountKey(BOB);
const INSP = 'insp-1';
const urgent: TagInfo = { id: 'tag-urgent', name: 'Urgent', color: '#f97316' };
const follow: TagInfo = { id: 'tag-follow', name: 'Follow Up' };

async function world() {
  const { db } = await resourceWorld();
  const rows = async (): Promise<Array<{ item: string; tag: string; state: string }>> =>
    (await db.query<{ item_id: string; tag_id: string; state: string }>('SELECT item_id, tag_id, state FROM item_tags ORDER BY item_id, tag_id')).map((r) => ({
      item: r.item_id,
      tag: r.tag_id,
      state: r.state,
    }));
  return { db, rows };
}

const row = (state: 'add' | 'remove', itemId = 'i1', tagId = urgent.id): TagRow => ({ inspectionId: INSP, itemId, tagId, name: 'x', color: null, state, updatedAt: 1 });

describe('adding and removing', () => {
  it('a tag the person adds is shown at once and waits to be sent', async () => {
    const { db } = await world();
    await addTag(db, A, INSP, 'i1', urgent, 10);
    expect(await readTags(db, A, INSP)).toEqual({ i1: [{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }] });
    expect((await pendingTags(db, A)).map((r) => [r.itemId, r.tagId, r.state])).toEqual([['i1', 'tag-urgent', 'add']]);
  });

  it('a colourless tag has no colour key', async () => {
    const { db } = await world();
    await addTag(db, A, INSP, 'i1', follow, 10);
    expect((await readTags(db, A, INSP)).i1?.[0]).toEqual({ id: 'tag-follow', name: 'Follow Up' });
  });

  it('adding a tag that is already there changes nothing, and does not make a synced tag pending again', async () => {
    const { db, rows } = await world();
    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 1);
    await addTag(db, A, INSP, 'i1', urgent, 20);
    expect(await rows()).toEqual([{ item: 'i1', tag: 'tag-urgent', state: 'synced' }]);
    await addTag(db, A, INSP, 'i1', follow, 21);
    await addTag(db, A, INSP, 'i1', follow, 22);
    expect((await rows()).filter((r) => r.tag === 'tag-follow')).toEqual([{ item: 'i1', tag: 'tag-follow', state: 'add' }]);
  });

  it('removing a tag the server was never told about just forgets it: nothing is sent', async () => {
    const { db, rows } = await world();
    await addTag(db, A, INSP, 'i1', urgent, 10);
    await removeTag(db, A, INSP, 'i1', urgent.id, 11);
    expect(await rows()).toEqual([]);
    expect(await pendingTags(db, A)).toEqual([]);
  });

  it('removing a tag the server has hides it and keeps a row so the removal can be sent', async () => {
    const { db } = await world();
    await mergeFromServer(db, A, INSP, { i1: [urgent, follow] }, 1);
    await removeTag(db, A, INSP, 'i1', urgent.id, 30);
    expect((await readTags(db, A, INSP)).i1?.map((t) => t.id)).toEqual(['tag-follow']);
    expect((await pendingTags(db, A)).map((r) => [r.tagId, r.state])).toEqual([['tag-urgent', 'remove']]);
  });

  it('removing a tag that is not there is a no-op', async () => {
    const { db, rows } = await world();
    await removeTag(db, A, INSP, 'i1', 'nope', 5);
    expect(await rows()).toEqual([]);
  });

  it('putting a tag back before its removal was sent cancels the removal', async () => {
    const { db, rows } = await world();
    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 1);
    await removeTag(db, A, INSP, 'i1', urgent.id, 30);
    await addTag(db, A, INSP, 'i1', urgent, 31);
    expect(await rows()).toEqual([{ item: 'i1', tag: 'tag-urgent', state: 'synced' }]);
    expect(await pendingTags(db, A)).toEqual([]);
  });
});

describe('what was sent', () => {
  it('an add the server took becomes synced; a removal the server took is deleted', async () => {
    const { db, rows } = await world();
    await addTag(db, A, INSP, 'i1', urgent, 10);
    await mergeFromServer(db, A, INSP, { i2: [follow] }, 11);
    await removeTag(db, A, INSP, 'i2', follow.id, 12);
    for (const pending of await pendingTags(db, A)) await settleSent(db, A, pending);
    expect(await rows()).toEqual([{ item: 'i1', tag: 'tag-urgent', state: 'synced' }]);
  });

  it('a person who changed their mind while the request was out is not overwritten', async () => {
    const { db, rows } = await world();
    await addTag(db, A, INSP, 'i1', urgent, 10);
    const [sent] = await pendingTags(db, A);
    await removeTag(db, A, INSP, 'i1', urgent.id, 11); // taken off again while the add was in flight
    await settleSent(db, A, sent!);
    expect(await rows()).toEqual([]); // no synced row is resurrected from a stale answer

    await mergeFromServer(db, A, INSP, { i1: [follow] }, 12);
    await removeTag(db, A, INSP, 'i1', follow.id, 13);
    const [removal] = await pendingTags(db, A);
    await addTag(db, A, INSP, 'i1', follow, 14); // put back while the removal was in flight
    await settleSent(db, A, removal!);
    expect(await rows()).toEqual([{ item: 'i1', tag: 'tag-follow', state: 'synced' }]); // not deleted
  });

  it('a rejected add is undone and a rejected removal is forgotten, but only while the row is as it was sent', async () => {
    const { db, rows } = await world();
    await addTag(db, A, INSP, 'i1', urgent, 10);
    await dropRejected(db, A, row('add'));
    expect(await rows()).toEqual([]);

    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 11);
    await removeTag(db, A, INSP, 'i1', urgent.id, 12);
    await dropRejected(db, A, row('remove'));
    expect(await rows()).toEqual([]);

    // Changed since it was sent: left alone.
    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 13);
    await dropRejected(db, A, row('add'));
    expect(await rows()).toEqual([{ item: 'i1', tag: 'tag-urgent', state: 'synced' }]);
  });
});

describe('merging what the server answered', () => {
  it('adds tags the device did not have and drops synced ones the server no longer has', async () => {
    const { db, rows } = await world();
    await mergeFromServer(db, A, INSP, { i1: [urgent], i2: [follow] }, 1);
    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 2);
    expect(await rows()).toEqual([{ item: 'i1', tag: 'tag-urgent', state: 'synced' }]);
  });

  it('keeps an add the server has not heard of, and settles an add the server already has', async () => {
    const { db, rows } = await world();
    await addTag(db, A, INSP, 'i1', urgent, 10);
    await addTag(db, A, INSP, 'i1', follow, 11);
    await mergeFromServer(db, A, INSP, { i1: [follow] }, 12);
    expect(await rows()).toEqual([
      { item: 'i1', tag: 'tag-follow', state: 'synced' },
      { item: 'i1', tag: 'tag-urgent', state: 'add' },
    ]);
  });

  it('lets a pending removal win over the server still having the tag', async () => {
    const { db } = await world();
    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 1);
    await removeTag(db, A, INSP, 'i1', urgent.id, 2);
    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 3);
    expect(await readTags(db, A, INSP)).toEqual({});
    expect((await pendingTags(db, A)).map((r) => r.state)).toEqual(['remove']);
  });

  it('takes the server\'s current name and colour', async () => {
    const { db } = await world();
    await mergeFromServer(db, A, INSP, { i1: [urgent] }, 1);
    await mergeFromServer(db, A, INSP, { i1: [{ id: 'tag-urgent', name: 'Urgent!', color: '#000000' }] }, 2);
    expect((await readTags(db, A, INSP)).i1).toEqual([{ id: 'tag-urgent', name: 'Urgent!', color: '#000000' }]);
  });
});

describe('scope', () => {
  it('another account sees none of this account\'s tags, and cannot change them', async () => {
    const { db } = await world();
    await addTag(db, A, INSP, 'i1', urgent, 10);
    expect(await readTags(db, B, INSP)).toEqual({});
    expect(await pendingTags(db, B)).toEqual([]);
    await removeTag(db, B, INSP, 'i1', urgent.id, 11);
    expect((await readTags(db, A, INSP)).i1).toHaveLength(1);
  });

  it('pending rows can be read for one inspection or for all of them', async () => {
    const { db } = await world();
    await addTag(db, A, 'insp-1', 'i1', urgent, 10);
    await addTag(db, A, 'insp-2', 'i1', follow, 11);
    expect((await pendingTags(db, A)).map((r) => r.inspectionId)).toEqual(['insp-1', 'insp-2']);
    expect((await pendingTags(db, A, 'insp-2')).map((r) => r.inspectionId)).toEqual(['insp-2']);
  });

  it('removing an inspection from the device takes its tags with it and nobody else\'s', async () => {
    const { db, rows } = await world();
    await addTag(db, A, 'insp-1', 'i1', urgent, 10);
    await addTag(db, A, 'insp-2', 'i1', urgent, 11);
    await addTag(db, B, 'insp-1', 'i1', urgent, 12);
    await deleteInspectionTags(db, A, 'insp-1');
    expect((await db.query('SELECT 1 FROM item_tags')).length).toBe(2);
    expect((await rows()).length).toBe(2);
    expect(await readTags(db, A, 'insp-2')).not.toEqual({});
    expect(await readTags(db, B, 'insp-1')).not.toEqual({});
  });

  it('refuses to read a row with a state it does not know', async () => {
    const { db } = await world();
    await db.run("INSERT INTO item_tags (account_key, inspection_id, item_id, tag_id, name, color, state, updated_at) VALUES (?, 'x', 'i', 't', 'n', NULL, 'weird', 1)", [A]);
    await expect(readTags(db, A, 'x')).rejects.toThrow(/unknown state/);
  });
});
