import { describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { MAX_MEDIA_BYTES } from '../media/media-types';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import type { ApiCall } from './api-client';
import { createPhotoCache, DEFAULT_PHOTO_CACHE_LIMITS } from './photo-cache';
import { ALICE, INSPECTION, JPEG, WEBP, fetchOnce, flush, key, ok, problem, rig, settle } from './test-support/photo-cache-rig';

describe('photo cache lifecycle', () => {
  it('a failing write is tried once, remembered, and tried again only after the long pause; the default file cap is the media cap', async () => {
    const r = await rig();
    r.files.failWrites();
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.maxBytes).toBe(MAX_MEDIA_BYTES);
    expect(DEFAULT_PHOTO_CACHE_LIMITS.maxFileBytes).toBe(MAX_MEDIA_BYTES);
    for (let i = 0; i < 3; i += 1) r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    r.clock.now += 60_000;
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    r.clock.now += 5 * 60_000;
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(2);
  });

  it('online but the server did not answer in time: retried after the pause with no network event', async () => {
    const r = await rig({ answerWith: problem('offline') });
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    r.clock.now += 31_000;
    r.answer(ok(JPEG));
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(2);
    flush(r);
    expect(r.cache.lookup(INSPECTION, key('p1'), 'thumb')).not.toBeNull();
  });

  it('a lookup made while the network flag has not read yet is not parked for good', async () => {
    let settled!: () => void;
    const ready = new Promise<void>((resolve) => (settled = resolve));
    let online = false;
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const calls: ApiCall[] = [];
    const cache = createPhotoCache({
      db,
      files: createMemoryFiles(),
      api: { send: (call) => (calls.push(call), Promise.resolve(ok(JPEG))) },
      account: ALICE,
      network: { ready, isOnline: () => online, onOnlineChange: () => () => undefined },
      clock: { now: () => 1 },
      timers: createManualTimers(),
    });
    cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(calls).toHaveLength(0);
    online = true;
    settled();
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('after dispose a download that lands writes nothing, tells nobody and nothing new is asked', async () => {
    const r = await rig({ deferred: true });
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    r.cache.dispose();
    r.release();
    await settle();
    flush(r);
    expect(r.files.paths()).toEqual([]);
    expect(await r.db.query('SELECT 1 FROM photo_cache')).toEqual([]);
    expect(r.notified()).toBe(0);
    expect(r.cache.lookup(INSPECTION, key('p2'), 'thumb')).toBeNull();
    await settle();
    expect(r.calls).toHaveLength(1);
  });

  it('what a session shows counts as used: a warm stamps the rows it brings in', async () => {
    const first = await rig();
    await fetchOnce(first, 'old');
    const second = await rig({ db: first.db, files: first.files });
    second.clock.now = first.clock.now + 10_000;
    await second.cache.warm(INSPECTION);
    const rows = await second.db.query<{ last_used_at: number }>('SELECT last_used_at FROM photo_cache');
    expect(rows).toHaveLength(1);
    expect(rows.every((x) => x.last_used_at === second.clock.now)).toBe(true);
  });

  it('a copy that comes back under another extension leaves one file, not two', async () => {
    const first = await rig();
    await fetchOnce(first, 'p1');
    await first.db.run('DELETE FROM photo_cache');
    const second = await rig({ db: first.db, files: first.files, answerWith: ok(WEBP, 'image/webp') });
    await fetchOnce(second, 'p1');
    expect(second.files.paths().filter((p) => p.startsWith('photo-cache/'))).toHaveLength(1);
    expect(second.files.paths().filter((p) => p.endsWith('.webp'))).toHaveLength(1);
  });
});
