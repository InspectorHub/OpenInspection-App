import { beforeEach, describe, expect, it } from 'vitest';
import { addTag, mergeFromServer, removeTag } from '../field/item-tags-store';
import { createManualClock } from '../platform/clock';
import { createWorkPackageRefresher } from './work-package';
import { INSPECTION } from '../media/test-support/fakes';
import { world as dataSourceWorld } from '../field/test-support/data-source-world';
import { ALICE_KEY, NOW, TODAY, createPackageServer, createPackageWorld, jsonReply, type PackageWorld } from './test-support/package-world';
import { ALICE, GOOD_TOKEN, ORIGIN } from './test-support/replay-world';

/**
 * The package download pulls each inspection's tags: when the refresh replaced an inspection's cached set it asks the server
 * for that inspection's tag map and merges the answer into `item_tags` (the same three-way merge as the editor's pull). The
 * pull is best effort: whatever goes wrong with it, the refresh and every other resource are as if it had not been tried.
 */

const TAGS = (id: string): string => `/api/inspections/${id}/tags`;
const map = (data: Record<string, { id: string; name: string; color?: string | null }[]>): unknown => ({
  success: true,
  data: Object.fromEntries(Object.entries(data).map(([item, tags]) => [item, tags.map((t) => ({ color: null, isSeed: false, createdAt: 1, ...t }))])),
});
const A = { id: 'tag-a', name: 'Alpha' };
const B = { id: 'tag-b', name: 'Beta', color: '#f97316' };

let w: PackageWorld;

beforeEach(async () => {
  w = await createPackageWorld();
});

function serveTags(id: string, body: unknown): void {
  w.pkg.overrides.set(TAGS(id), () => jsonReply(200, body));
}

async function rows(id = 't1'): Promise<string[]> {
  return (await w.db.query<{ item_id: string; tag_id: string; state: string }>('SELECT item_id, tag_id, state FROM item_tags WHERE inspection_id = ? ORDER BY item_id, tag_id', [id])).map((r) => `${r.item_id}/${r.tag_id}/${r.state}`);
}

describe('a refresh brings the tags onto the device', () => {
  it('a 200 tag map is kept as synced rows, with the names and colours it carries', async () => {
    w.serve('t1');
    serveTags('t1', map({ i1: [A, B], i2: [A] }));
    expect(await w.run()).toMatchObject({ refreshed: 1, failed: 0, halted: null });
    expect(await rows()).toEqual(['i1/tag-a/synced', 'i1/tag-b/synced', 'i2/tag-a/synced']);
    const colour = await w.db.query<{ color: string | null }>("SELECT color FROM item_tags WHERE tag_id = 'tag-b'");
    expect(colour[0]?.color).toBe('#f97316');
  });

  it('the answer is not stored in the cache, so no package changes shape and no later read can use an old copy', async () => {
    w.serve('t1');
    serveTags('t1', map({ i1: [A] }));
    await w.run();
    expect(await w.cachedKeys('t1')).toEqual(['/api/inspections/t1', '/api/inspections/t1/report-data', '/api/inspections/t1/results']);
    // A package that is fresh is not downloaded again for want of tags.
    w.pkg.requests.length = 0;
    await w.run('start');
    expect(w.pkg.forInspection('t1')).toEqual([]);
  });

  it('a second refresh with a changed map updates the synced rows and keeps a pending add and a pending remove', async () => {
    w.serve('t1');
    serveTags('t1', map({ i1: [A], i3: [B] }));
    await w.run();
    // Between the two refreshes the person added tag-p to i2 and took tag-b off i3; neither has been sent.
    await addTag(w.db, ALICE_KEY, 't1', 'i2', { id: 'tag-p', name: 'Pending' }, NOW);
    await removeTag(w.db, ALICE_KEY, 't1', 'i3', 'tag-b', NOW);
    expect(await rows()).toEqual(['i1/tag-a/synced', 'i2/tag-p/add', 'i3/tag-b/remove']);
    // The server dropped tag-a and added tag-n; it still has tag-b on i3.
    serveTags('t1', map({ i1: [{ id: 'tag-n', name: 'New' }], i3: [B] }));
    await w.run('manual');
    expect(await rows()).toEqual(['i1/tag-n/synced', 'i2/tag-p/add', 'i3/tag-b/remove']);
  });

  it.each([
    ['404', () => jsonReply(404, { success: false })],
    ['403', () => jsonReply(403, { success: false })],
    ['500', () => jsonReply(500, { success: false })],
    ['429', () => jsonReply(429, { success: false })],
    ['304', () => jsonReply(304, '')],
    ['a 500 that carries a valid tag map', () => jsonReply(500, map({ i9: [B] }))],
    ['a 403 that carries a valid tag map', () => jsonReply(403, map({ i9: [B] }))],
    ['a network error', () => new Error('offline')],
    ['an envelope that is not a tag map', () => jsonReply(200, { success: true, data: { path: '/x', v: 1 } })],
    ['a body that is not JSON', () => jsonReply(200, 'not json at all')],
    ['a list instead of a map', () => jsonReply(200, { success: true, data: [] })],
    ['a failure envelope', () => jsonReply(200, { success: false })],
  ])('%s leaves item_tags as it was and the refresh succeeds with everything else stored', async (_name, answer) => {
    w.serve('t1');
    await mergeFromServer(w.db, ALICE_KEY, 't1', { i1: [A] }, 1);
    await addTag(w.db, ALICE_KEY, 't1', 'i2', { id: 'tag-p', name: 'Pending' }, NOW);
    w.pkg.overrides.set(TAGS('t1'), answer);
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 1, failed: 0, notVisible: 0, halted: null });
    expect(await w.cachedKeys('t1')).toEqual(['/api/inspections/t1', '/api/inspections/t1/report-data', '/api/inspections/t1/results']);
    expect(summary.globalRefreshed).toBe(true);
    expect(await rows()).toEqual(['i1/tag-a/synced', 'i2/tag-p/add']);
    expect(w.refreshErrors).toEqual([]);
    expect(await w.db.query("SELECT 1 FROM resource_cache WHERE key LIKE '$refresh_error:%'")).toEqual([]);
  });

  it('failing tag answers for many inspections never stop the run, whatever the error limit', async () => {
    for (const id of ['t1', 't2', 't3', 't4', 't5', 't6', 't7']) {
      w.serve(id);
      w.pkg.overrides.set(TAGS(id), () => jsonReply(500, { success: false }));
    }
    expect(await w.run()).toMatchObject({ refreshed: 7, failed: 0, halted: null });
  });

  it('an inspection that began to be removed while the tags were on their way is left alone', async () => {
    w.serve('t1');
    serveTags('t1', map({ i1: [A] }));
    w.pkg.hook = async (request) => {
      if (request.path === TAGS('t1')) await w.db.run("UPDATE work_package SET purging = 1 WHERE inspection_id = 't1'");
    };
    expect(await w.run()).toMatchObject({ refreshed: 1, halted: null });
    expect(await rows()).toEqual([]);
  });

  it('a quarantined inspection is left alone too, and its pending rows are untouched', async () => {
    w.serve('t1');
    await addTag(w.db, ALICE_KEY, 't1', 'i2', { id: 'tag-p', name: 'Pending' }, NOW);
    serveTags('t1', map({ i1: [A] }));
    w.pkg.hook = async (request) => {
      if (request.path === TAGS('t1')) await w.db.run("UPDATE work_package SET quarantine_source = 'test' WHERE inspection_id = 't1'");
    };
    await w.run();
    expect(await rows()).toEqual(['i2/tag-p/add']);
  });

  it('control: the same inspection, not blocked, is merged', async () => {
    w.serve('t1');
    serveTags('t1', map({ i1: [A] }));
    w.pkg.hook = async () => undefined;
    await w.run();
    expect(await rows()).toEqual(['i1/tag-a/synced']);
  });

  it('a merge that cannot be written is reported and does not fail the refresh', async () => {
    w.serve('t1');
    serveTags('t1', map({ i1: [A] }));
    const real = w.db.transaction.bind(w.db);
    w.pkg.hook = (request) => {
      if (request.path !== TAGS('t1')) return;
      w.db.transaction = ((fn: Parameters<typeof real>[0]) => real((tx) => fn({ ...tx, query: (sql: string, params?: unknown[]) => (sql.includes('item_tags') ? Promise.reject(new Error('disk full')) : tx.query(sql, params)) } as typeof tx))) as typeof real;
    };
    const summary = await w.run();
    w.db.transaction = real;
    expect(summary).toMatchObject({ refreshed: 1, failed: 0, halted: null });
    expect(w.refreshErrors).toHaveLength(1);
    expect(await rows()).toEqual([]);
    expect(await w.cachedKeys('t1')).toHaveLength(3);
  });

  it('uses only what the required reads left of the request budget, and never halts the run for lack of it', async () => {
    // 4 list reads, 3 base reads for each of two inspections and the 5 globals = 15; one request is left for the tags.
    w = await createPackageWorld({ limits: { maxRequests: 16 } });
    w.serve('t1');
    w.serve('t2');
    serveTags('t1', map({ i1: [A] }));
    serveTags('t2', map({ i1: [A] }));
    const summary = await w.run();
    expect(summary).toMatchObject({ refreshed: 2, halted: null });
    expect(summary.requests).toBe(16);
    expect((await rows('t1')).length + (await rows('t2')).length).toBe(1);
  });

  it('rotates the tag pull budget across repeated package refreshes, including after refresher restart', async () => {
    const count = 120;
    for (let n = 0; n < count; n += 1) {
      const id = `large-${String(n).padStart(3, '0')}`;
      w.serve(id);
      serveTags(id, map({}));
    }

    const pulled = new Set<string>();
    const batches: string[][] = [];
    for (let round = 0; round < 5; round += 1) {
      if (round > 0) w.clock.set(NOW + round * 300_001);
      // A new refresher on each pass models an app restart while the local database remains.
      const refresher = w.build();
      const start = w.pkg.requests.length;
      const summary = await refresher.refresh({ reason: round === 0 ? 'manual' : 'foreground' });
      const batch = w.pkg.requests.slice(start)
        .filter((request) => /^\/api\/inspections\/large-\d{3}\/tags$/.test(request.path))
        .map((request) => request.path.split('/')[3] ?? '');
      batches.push(batch);
      batch.forEach((id) => pulled.add(id));
      expect(summary).toMatchObject({ refreshed: count, halted: null });
      expect(summary.requests).toBeLessThanOrEqual(400);
    }

    expect(batches[0]?.length).toBeGreaterThan(0);
    expect(new Set(batches.flat()).size).toBe(count);
    expect(pulled.size).toBe(count);
  });

  it('a single-inspection refresh (after a write) pulls its tags too', async () => {
    w.serve('t1');
    await w.seed('t1');
    serveTags('t1', map({ i1: [A] }));
    expect(await w.refresher.refreshInspection('t1')).toEqual({ kind: 'refreshed' });
    expect(await rows()).toEqual(['i1/tag-a/synced']);
  });

  it('another account\'s rows are not touched', async () => {
    w.serve('t1');
    await mergeFromServer(w.db, 'other%3Aaccount', 't1', { i9: [B] }, 1);
    serveTags('t1', map({ i1: [A] }));
    await w.run();
    expect((await w.db.query<{ account_key: string; tag_id: string }>('SELECT account_key, tag_id FROM item_tags ORDER BY tag_id')).map((r) => `${r.account_key}/${r.tag_id}`)).toEqual([`${ALICE_KEY}/tag-a`, 'other%3Aaccount/tag-b']);
  });
});

describe('through the editor data source', () => {
  it('after a refresh, a first OFFLINE open shows the tags the server has', async () => {
    const ds = await dataSourceWorld();
    const pkg = createPackageServer();
    pkg.inspections.set(INSPECTION, { date: `${TODAY}T15:00:00.000Z`, status: 'scheduled', inspectorId: ALICE.userId });
    pkg.overrides.set(TAGS(INSPECTION), () => jsonReply(200, map({ itm_cover: [A, B] })));
    const refresher = createWorkPackageRefresher({
      db: ds.db,
      http: pkg.http,
      tokens: { getAccessToken: () => Promise.resolve(GOOD_TOKEN), checkSession: () => Promise.resolve({ kind: 'ok' } as never) },
      origin: ORIGIN,
      account: () => ALICE,
      isLocked: () => false,
      network: { online: () => Promise.resolve(true), onChange: () => () => undefined },
      clock: createManualClock(NOW),
      newToken: () => 'holder',
      random: () => 0.5,
    });
    expect(await ds.source.resources.itemTags?.list(INSPECTION)).toEqual({});
    ds.online.value = false;
    expect(await ds.source.resources.itemTags?.list(INSPECTION)).toEqual({});
    expect(await refresher.refresh({ reason: 'manual' })).toMatchObject({ refreshed: 1, halted: null });
    // Offline: what is read is what the device holds, and it holds the server's answer.
    const tags = await ds.source.resources.itemTags?.list(INSPECTION);
    expect(Object.keys(tags ?? {})).toEqual(['itm_cover']);
    expect(tags?.itm_cover?.map((t) => t.id)).toEqual(['tag-a', 'tag-b']);
    expect(tags?.itm_cover?.[1]).toEqual({ id: 'tag-b', name: 'Beta', color: '#f97316' });
  });
});
