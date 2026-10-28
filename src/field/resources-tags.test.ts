import { describe, expect, it, vi } from 'vitest';
import { accountKey } from '../offline/outbox';
import { pendingTags, readTags } from './item-tags-store';
import { createResources } from './resources';
import { createItemTags } from './resources-tags';
import { MESSAGES } from './messages';
import { cacheRow, resourceWorld } from './test-support/resource-world';
import { reply, type ScriptedApi } from './test-support/scripted-api';
import { ALICE } from './test-support/seed-package';
import type { ApiOutcome } from './api-client';

const A = accountKey(ALICE);
const OK = reply(200, { success: true });
const library = [
  { id: 'tag-urgent', name: 'Urgent', color: '#f97316' },
  { id: 'tag-follow', name: 'Follow Up', color: null },
];

async function build(opts: { online?: boolean; answers?: ApiOutcome[]; library?: boolean } = {}) {
  const w = await resourceWorld({ online: opts.online ?? true, answers: opts.answers ?? [] });
  if (opts.library !== false) await cacheRow(w.db, '/api/tags', library);
  const rejected: number[] = [];
  const tags = createItemTags(w.deps, { now: () => 1000, onRejected: (n) => rejected.push(n) });
  return { ...w, tags, rejected };
}

/** The unsent change is told to the server in the background; wait until the call has been made and settled. */
const sent = async (api: ScriptedApi, n: number) => vi.waitFor(() => expect(api.calls.length).toBeGreaterThanOrEqual(n));
const idle = async (t: Awaited<ReturnType<typeof build>>) => {
  await t.tags.sync.flush(); // runs after any flush already in flight, so it returns once that one has settled
};

describe('offline', () => {
  it('stores a toggle on the device at once, answers ok, and sends nothing', async () => {
    const t = await build({ online: false });
    expect(await t.tags.add('insp-1', 'i1', 'tag-urgent')).toEqual({ ok: true });
    expect(await t.tags.list('insp-1')).toEqual({ i1: [{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }] });
    expect(t.api.calls).toEqual([]);
    expect((await pendingTags(t.db, A)).map((r) => r.state)).toEqual(['add']);
  });

  it('shows the tags a person put on, after the app is restarted (they are in the database, not in memory)', async () => {
    const t = await build({ online: false });
    await t.tags.add('insp-1', 'i1', 'tag-urgent');
    const restarted = createItemTags(t.deps, { now: () => 2000 });
    expect(Object.keys((await restarted.list('insp-1')) ?? {})).toEqual(['i1']);
  });

  it('answers an empty map, not a failure, for an inspection with nothing tagged', async () => {
    const t = await build({ online: false });
    expect(await t.tags.list('insp-1')).toEqual({});
  });

  it('a removal of a tag that was never sent leaves nothing to send later', async () => {
    const t = await build({ online: false });
    await t.tags.add('insp-1', 'i1', 'tag-urgent');
    expect(await t.tags.remove('insp-1', 'i1', 'tag-urgent')).toEqual({ ok: true });
    expect(await pendingTags(t.db, A)).toEqual([]);
    expect(await t.tags.list('insp-1')).toEqual({});
  });
});

describe('online', () => {
  it('tells the server about an added tag without making the toggle wait for it', async () => {
    const t = await build({ answers: [OK] });
    expect(await t.tags.add('insp-1', 'i1', 'tag-urgent')).toEqual({ ok: true });
    await sent(t.api, 1);
    expect(t.api.calls[0]).toEqual({ method: 'POST', path: '/api/inspections/insp-1/items/i1/tags', json: { tagId: 'tag-urgent' } });
    await idle(t);
    expect(await pendingTags(t.db, A)).toEqual([]);
    expect((await readTags(t.db, A, 'insp-1')).i1).toHaveLength(1);
  });

  it('tells the server about a removed tag', async () => {
    const t = await build({ answers: [reply(200, { success: true, data: { i1: [{ id: 'tag-urgent', name: 'Urgent' }] } }), OK] });
    await t.tags.list('insp-1'); // brings the server's tag in
    t.api.calls.length = 0;
    expect(await t.tags.remove('insp-1', 'i1', 'tag-urgent')).toEqual({ ok: true });
    await sent(t.api, 1);
    expect(t.api.calls[0]).toEqual({ method: 'DELETE', path: '/api/inspections/insp-1/items/i1/tags/tag-urgent' });
    await idle(t);
    expect(await pendingTags(t.db, A)).toEqual([]);
    expect(await t.tags.list('insp-1')).toEqual({});
  });

  it('opening an inspection first sends every unsent change of the account, then reads this inspection', async () => {
    const t = await build({ online: false });
    await t.tags.add('insp-other', 'i9', 'tag-follow'); // made offline, on another inspection
    t.state.online = true;
    const server = reply(200, { success: true, data: { i1: [{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }] } });
    t.api.send = async (call) => {
      t.api.calls.push(call);
      return call.method === 'GET' ? server : OK;
    };
    const map = await t.tags.list('insp-1');
    expect(t.api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/inspections/insp-other/items/i9/tags', 'GET /api/inspections/insp-1/tags']);
    expect(map).toEqual({ i1: [{ id: 'tag-urgent', name: 'Urgent', color: '#f97316' }] });
    expect(await pendingTags(t.db, A)).toEqual([]);
  });

  it('shows what is on the device when the read fails, rather than failing', async () => {
    const t = await build({ answers: [reply(500, {})] });
    await t.tags.add('insp-1', 'i1', 'tag-urgent');
    await idle(t);
    t.api.calls.length = 0;
    expect(Object.keys((await t.tags.list('insp-1')) ?? {})).toEqual(['i1']);
  });

  it('tells the person once when the server refused changes for good', async () => {
    const t = await build({ answers: [reply(404, {})] });
    await t.tags.add('insp-1', 'i1', 'tag-urgent');
    await vi.waitFor(() => expect(t.rejected).toEqual([1]));
    expect(await readTags(t.db, A, 'insp-1')).toEqual({});
  });
});

describe('what a tag is called', () => {
  it('takes the name and colour from the tag library the app already holds', async () => {
    const t = await build({ online: false });
    await t.tags.add('insp-1', 'i1', 'tag-follow');
    expect((await t.tags.list('insp-1'))?.i1).toEqual([{ id: 'tag-follow', name: 'Follow Up' }]);
  });

  it('shows a tag the library does not list by its id rather than failing', async () => {
    const t = await build({ online: false, library: false });
    await t.tags.add('insp-1', 'i1', 'tag-x');
    expect((await t.tags.list('insp-1'))?.i1).toEqual([{ id: 'tag-x', name: 'tag-x' }]);
  });
});

describe('refusals', () => {
  it('does not read or change an inspection that is being removed from the device', async () => {
    const t = await build({ online: false });
    t.state.blocked.add('insp-1');
    expect(await t.tags.list('insp-1')).toBeNull();
    expect(await t.tags.add('insp-1', 'i1', 'tag-urgent')).toEqual({ ok: false, error: MESSAGES.blocked });
    expect(await t.tags.remove('insp-1', 'i1', 'tag-urgent')).toEqual({ ok: false, error: MESSAGES.blocked });
    expect(await pendingTags(t.db, A)).toEqual([]);
  });

  it.each([
    ['an empty item id', 'insp-1', '', 'tag-urgent'],
    ['an empty tag id', 'insp-1', 'i1', ''],
    ['an over-long id', 'insp-1', 'i1', 'x'.repeat(129)],
    ['an id with a control character', 'insp-1', 'i\u0007', 'tag-urgent'],
    ['an empty inspection id', '', 'i1', 'tag-urgent'],
  ])('refuses %s without storing anything', async (_name, insp, item, tag) => {
    const t = await build({ online: false });
    expect(await t.tags.add(insp, item, tag)).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect(await t.tags.remove(insp, item, tag)).toEqual({ ok: false, error: MESSAGES.invalidValue });
    expect((await t.db.query('SELECT 1 FROM item_tags')).length).toBe(0);
  });

  it('answers a failure, not a throw, when the database is unusable', async () => {
    const t = await build({ online: false });
    t.deps.db.run = () => Promise.reject(new Error('disk full'));
    t.deps.db.query = () => Promise.reject(new Error('disk full'));
    t.deps.db.transaction = () => Promise.reject(new Error('disk full'));
    expect(await t.tags.add('insp-1', 'i1', 'tag-urgent')).toEqual({ ok: false, error: MESSAGES.notSaved });
    expect(await t.tags.list('insp-1')).toBeNull();
  });
});

describe('the editor data source', () => {
  it('has the member among its resources', async () => {
    const t = await build();
    const resources = createResources(t.deps);
    expect(typeof resources.itemTags.list).toBe('function');
    expect(typeof resources.itemTags.add).toBe('function');
    expect(typeof resources.itemTags.remove).toBe('function');
  });
});
