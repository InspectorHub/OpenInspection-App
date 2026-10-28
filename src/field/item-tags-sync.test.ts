import { describe, expect, it, vi } from 'vitest';
import { accountKey } from '../offline/outbox';
import type { Api, ApiOutcome } from './api-client';
import { addTag, mergeFromServer, pendingTags, readTags, removeTag, type TagInfo } from './item-tags-store';
import { createItemTagSync } from './item-tags-sync';
import { resourceWorld } from './test-support/resource-world';
import { reply, scriptedApi } from './test-support/scripted-api';
import { ALICE } from './test-support/seed-package';

const A = accountKey(ALICE);
const urgent: TagInfo = { id: 'tag-urgent', name: 'Urgent', color: '#f97316' };
const follow: TagInfo = { id: 'tag-follow', name: 'Follow Up' };
const OK = reply(200, { success: true });
const problem = (p: 'offline' | 'unknown' | 'auth' | 'locked' | 'upgrade' | 'server_too_old'): ApiOutcome => ({ kind: 'problem', problem: p });

async function build(answers: ApiOutcome[] = [], over: { online?: boolean } = {}) {
  const w = await resourceWorld({ online: over.online ?? true });
  const api = scriptedApi(...answers);
  const rejected: number[] = [];
  const sync = createItemTagSync({
    api,
    db: w.db,
    account: ALICE,
    isOnline: () => w.state.online,
    isBlocked: (id) => Promise.resolve(w.state.blocked.has(id)),
    now: () => 100,
    onRejected: (n) => rejected.push(n),
  });
  const states = async () => (await w.db.query<{ i: string; item_id: string; tag_id: string; state: string }>('SELECT inspection_id AS i, item_id, tag_id, state FROM item_tags ORDER BY inspection_id, item_id, tag_id')).map((r) => `${r.i}/${r.item_id}/${r.tag_id}:${r.state}`);
  return { ...w, api, sync, rejected, states };
}

describe('flush — sending what the server has not heard', () => {
  it('sends an add as a POST of the tag id and settles it, and a removal as a DELETE and forgets it', async () => {
    const t = await build([OK, OK]);
    await addTag(t.db, A, 'insp-1', 'i1', urgent, 1);
    await mergeFromServer(t.db, A, 'insp-2', { i2: [follow] }, 2);
    await removeTag(t.db, A, 'insp-2', 'i2', follow.id, 3);
    expect(await t.sync.flush()).toEqual({ sent: 2, rejected: 0 });
    expect(t.api.calls).toEqual([
      { method: 'POST', path: '/api/inspections/insp-1/items/i1/tags', json: { tagId: 'tag-urgent' } },
      { method: 'DELETE', path: '/api/inspections/insp-2/items/i2/tags/tag-follow' },
    ]);
    expect(await t.states()).toEqual(['insp-1/i1/tag-urgent:synced']);
  });

  it('sends nothing and changes nothing while the device is offline', async () => {
    const t = await build([], { online: false });
    await addTag(t.db, A, 'insp-1', 'i1', urgent, 1);
    expect(await t.sync.flush()).toEqual({ sent: 0, rejected: 0 });
    expect(t.api.calls).toEqual([]);
    expect(await t.states()).toEqual(['insp-1/i1/tag-urgent:add']);
  });

  it('can be limited to one inspection', async () => {
    const t = await build([OK]);
    await addTag(t.db, A, 'insp-1', 'i1', urgent, 1);
    await addTag(t.db, A, 'insp-2', 'i1', follow, 2);
    await t.sync.flush('insp-2');
    expect(t.api.calls.map((c) => c.path)).toEqual(['/api/inspections/insp-2/items/i1/tags']);
    expect(await t.states()).toEqual(['insp-1/i1/tag-urgent:add', 'insp-2/i1/tag-follow:synced']);
  });

  it('leaves the rows of an inspection that is being removed from the device alone, and still sends the others', async () => {
    const t = await build([OK]);
    await addTag(t.db, A, 'insp-gone', 'i1', urgent, 1);
    await addTag(t.db, A, 'insp-2', 'i1', follow, 2);
    t.state.blocked.add('insp-gone');
    await t.sync.flush();
    expect(t.api.calls.map((c) => c.path)).toEqual(['/api/inspections/insp-2/items/i1/tags']);
    expect(await t.states()).toEqual(['insp-2/i1/tag-follow:synced', 'insp-gone/i1/tag-urgent:add'].sort());
  });
});

describe('flush — what the server refuses for good', () => {
  it.each([400, 403, 404, 409, 422])('a %i drops that row on its own and the next one is still sent', async (status) => {
    const t = await build([reply(status, {}), OK]);
    await addTag(t.db, A, 'insp-1', 'i1', urgent, 1); // the server refuses this one (a tag deleted elsewhere)
    await addTag(t.db, A, 'insp-1', 'i2', follow, 2);
    expect(await t.sync.flush()).toEqual({ sent: 1, rejected: 1 });
    expect(await t.states()).toEqual(['insp-1/i2/tag-follow:synced']);
    expect(t.rejected).toEqual([1]);
    // A refused add is undone on screen, not left standing.
    expect(await readTags(t.db, A, 'insp-1')).toEqual({ i2: [{ id: 'tag-follow', name: 'Follow Up' }] });
  });

  it('a refused removal is forgotten, so it is not sent again', async () => {
    const t = await build([reply(404, {})]);
    await mergeFromServer(t.db, A, 'insp-1', { i1: [urgent] }, 1);
    await removeTag(t.db, A, 'insp-1', 'i1', urgent.id, 2);
    await t.sync.flush();
    expect(await t.states()).toEqual([]);
    await t.sync.flush();
    expect(t.api.calls).toHaveLength(1);
  });

  it('does not tell the caller about a rejection when there was none', async () => {
    const t = await build([OK]);
    await addTag(t.db, A, 'insp-1', 'i1', urgent, 1);
    await t.sync.flush();
    expect(t.rejected).toEqual([]);
  });

  it('a name that cannot be part of a path is dropped without any request', async () => {
    const t = await build([]);
    await addTag(t.db, A, 'insp-1', 'a/b', urgent, 1);
    expect(await t.sync.flush()).toEqual({ sent: 0, rejected: 1 });
    expect(t.api.calls).toEqual([]);
    expect(await t.states()).toEqual([]);
  });
});

describe('flush — what is tried again later', () => {
  it.each([
    ['a 500', reply(500, {})],
    ['a 429', reply(429, {})],
    ['a 408', reply(408, {})],
    ['no connection', problem('offline')],
    ['a lost answer', problem('unknown')],
    ['a signed-out session', problem('auth')],
    ['the offline lock', problem('locked')],
    ['a server that is too old', problem('server_too_old')],
    ['a page that is not the server\'s', reply(200, '<html>login</html>')],
    ['a success without the success flag', reply(200, {})],
  ])('%s leaves the rows pending and stops this round', async (_name, answer) => {
    const t = await build([answer]);
    await addTag(t.db, A, 'insp-1', 'i1', urgent, 1);
    await addTag(t.db, A, 'insp-1', 'i2', follow, 2);
    expect(await t.sync.flush()).toEqual({ sent: 0, rejected: 0 });
    expect(t.api.calls).toHaveLength(1);
    expect(await t.states()).toEqual(['insp-1/i1/tag-urgent:add', 'insp-1/i2/tag-follow:add']);
    expect(t.rejected).toEqual([]);
    // The next round starts again with the same row.
    t.api.calls.length = 0;
    await t.sync.flush();
    expect(t.api.calls[0]?.json).toEqual({ tagId: 'tag-urgent' });
  });
});

describe('a person who changes their mind while a request is out', () => {
  it('is not overwritten by the answer to the older request', async () => {
    const w = await resourceWorld();
    const sync = createItemTagSync({
      api: {
        send: async () => {
          await removeTag(w.db, A, 'insp-1', 'i1', urgent.id, 50); // taken off again while the add is in flight
          return OK;
        },
      } satisfies Api,
      db: w.db,
      account: ALICE,
      isOnline: () => true,
      isBlocked: () => Promise.resolve(false),
      now: () => 100,
    });
    await addTag(w.db, A, 'insp-1', 'i1', urgent, 1);
    await sync.flush();
    expect(await pendingTags(w.db, A)).toEqual([]);
    expect(await readTags(w.db, A, 'insp-1')).toEqual({});
  });
});

describe('pull — reading what the server has', () => {
  const server = reply(200, { success: true, data: { i1: [{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }], i2: [{ id: 'tag-follow', name: 'Follow Up', color: null }] } });

  it('asks for the inspection\'s tags and brings them in', async () => {
    const t = await build([server]);
    expect(await t.sync.pull('insp-1')).toBe(true);
    expect(t.api.calls).toEqual([{ method: 'GET', path: '/api/inspections/insp-1/tags' }]);
    expect(await readTags(t.db, A, 'insp-1')).toEqual({
      i1: [{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }],
      i2: [{ id: 'tag-follow', name: 'Follow Up' }],
    });
  });

  it('keeps a change the server has not heard yet', async () => {
    const t = await build([server]);
    await addTag(t.db, A, 'insp-1', 'i3', follow, 1);
    await t.sync.pull('insp-1');
    expect((await readTags(t.db, A, 'insp-1')).i3).toEqual([{ id: 'tag-follow', name: 'Follow Up' }]);
  });

  it.each([
    ['an error status', reply(500, {})],
    ['a body without the success flag', reply(200, { data: {} })],
    ['a body that is not an object', reply(200, 'nope')],
    ['no answer', problem('offline')],
  ])('answers false and changes nothing for %s', async (_name, answer) => {
    const t = await build([answer]);
    await mergeFromServer(t.db, A, 'insp-1', { i1: [urgent] }, 1);
    expect(await t.sync.pull('insp-1')).toBe(false);
    expect((await readTags(t.db, A, 'insp-1')).i1).toHaveLength(1);
  });

  it('does not ask while offline or for an inspection that is being removed', async () => {
    const off = await build([server], { online: false });
    expect(await off.sync.pull('insp-1')).toBe(false);
    expect(off.api.calls).toEqual([]);
    const blocked = await build([server]);
    blocked.state.blocked.add('insp-1');
    expect(await blocked.sync.pull('insp-1')).toBe(false);
    expect(blocked.api.calls).toEqual([]);
  });

  it('skips entries that are not tags rather than failing the whole answer', async () => {
    const t = await build([reply(200, { success: true, data: { i1: [{ id: 'ok', name: 'Fine' }, { id: 5 }, 'x', null, { name: 'no id' }], i2: 'not a list' } })]);
    expect(await t.sync.pull('insp-1')).toBe(true);
    expect(await readTags(t.db, A, 'insp-1')).toEqual({ i1: [{ id: 'ok', name: 'Fine' }] });
  });

  it('never runs at the same time as a flush: the send settles before the read', async () => {
    const order: string[] = [];
    const w = await resourceWorld();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sync = createItemTagSync({
      api: {
        send: async (call) => {
          order.push(`start ${call.method}`);
          if (call.method === 'POST') await gate;
          order.push(`end ${call.method}`);
          // After the add landed, the server has the tag: that is what a read that follows the send is told.
          return call.method === 'POST' ? OK : reply(200, { success: true, data: { i1: [{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }] } });
        },
      } satisfies Api,
      db: w.db,
      account: ALICE,
      isOnline: () => true,
      isBlocked: () => Promise.resolve(false),
      now: () => 100,
    });
    await addTag(w.db, A, 'insp-1', 'i1', urgent, 1);
    const flushing = sync.flush();
    const pulling = sync.pull('insp-1');
    await vi.waitFor(() => expect(order).toEqual(['start POST']));
    release();
    await Promise.all([flushing, pulling]);
    expect(order).toEqual(['start POST', 'end POST', 'start GET', 'end GET']);
    expect((await readTags(w.db, A, 'insp-1')).i1).toEqual([{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }]);
    expect(await pendingTags(w.db, A)).toEqual([]);
  });
});
