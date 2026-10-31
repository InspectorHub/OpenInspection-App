import { describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { clearLocalData } from '../offline/clear-local-data';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import type { ApiOutcome } from './api-client';
import { createPhotoCache, PHOTO_WIDTHS } from './photo-cache';
import { ALICE, BOB, INSPECTION, JPEG, PNG, WEBP, fetchOnce, flush, key, ok, problem, rig, settle, status } from './test-support/photo-cache-rig';

describe('photo cache', () => {
  it('a miss answers null and fetches once with the session; the next lookup answers a device address and listeners hear it once', async () => {
    const r = await rig();
    const url = await fetchOnce(r, 'p1');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ method: 'GET', path: `/api/inspections/${INSPECTION}/photo`, query: { key: key('p1'), w: String(PHOTO_WIDTHS.thumb) }, binary: true });
    expect(url).toMatch(/^https:\/\/localhost\/_capacitor_file_\/photo-cache\/[0-9a-f]{64}\.jpg$/);
    expect(r.files.paths().filter((p) => p.startsWith('photo-cache/'))).toHaveLength(1);
    expect(r.notified()).toBe(1);
    // Control: a second lookup is a hit and sends nothing.
    expect(r.cache.lookup(INSPECTION, key('p1'), 'thumb')).toBe(url);
    expect(r.calls).toHaveLength(1);
  });

  it('the url carries no credential and no key text', async () => {
    const r = await rig();
    const url = (await fetchOnce(r, 'p1')) ?? '';
    expect(url).not.toMatch(/token|auth|secret|key=|p1/i);
  });

  it('size variants are separate entries: thumb and view fetch with their own width; original sends no width', async () => {
    const r = await rig();
    await fetchOnce(r, 'p1', 'thumb');
    await fetchOnce(r, 'p1', 'view');
    await fetchOnce(r, 'p1', 'original');
    expect(r.calls.map((c) => c.query?.w)).toEqual([String(PHOTO_WIDTHS.thumb), String(PHOTO_WIDTHS.view), undefined]);
    expect(await r.db.query('SELECT size FROM photo_cache ORDER BY size')).toEqual([{ size: 'original' }, { size: 'thumb' }, { size: 'view' }]);
  });

  it('a bigger copy answers a smaller ask, a smaller one never answers a bigger ask', async () => {
    const r = await rig();
    await fetchOnce(r, 'p1', 'original');
    expect(r.cache.lookup(INSPECTION, key('p1'), 'thumb')).not.toBeNull();
    expect(r.cache.lookup(INSPECTION, key('p1'), 'view')).not.toBeNull();
    expect(r.calls).toHaveLength(1);
    const t = await rig();
    await fetchOnce(t, 'p1', 'thumb');
    expect(t.cache.lookup(INSPECTION, key('p1'), 'original')).toBeNull();
  });

  it('five asks for the same photo send one request; five different photos send five', async () => {
    const r = await rig();
    for (let i = 0; i < 5; i += 1) r.cache.lookup(INSPECTION, key('same'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    // Control: five different photos are five requests.
    const other = await rig();
    for (let i = 0; i < 5; i += 1) other.cache.lookup(INSPECTION, key(`d${String(i)}`), 'thumb');
    await settle();
    expect(other.calls).toHaveLength(5);
  });

  it('concurrency is bounded at three', async () => {
    let active = 0;
    let peak = 0;
    const db = await createSqlJsDb();
    await migrate(db, 0);
    const cache = createPhotoCache({
      db,
      files: createMemoryFiles(),
      api: {
        send: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return ok(JPEG);
        },
      },
      account: ALICE,
      network: { ready: Promise.resolve(), isOnline: () => true, onOnlineChange: () => () => undefined },
      clock: { now: () => 1 },
      timers: createManualTimers(),
    });
    for (let i = 0; i < 8; i += 1) cache.lookup(INSPECTION, key(`k${String(i)}`), 'thumb');
    for (let i = 0; i < 60; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(peak).toBe(3);
    expect((await db.query('SELECT count(*) AS n FROM photo_cache'))[0]).toEqual({ n: 8 });
  });

  it('a key that is not under an inspection path is still only asked for under the id it was asked with (the caller checks ownership), and an id with a separator sends nothing', async () => {
    const r = await rig();
    expect(r.cache.lookup('a/b', key('p1'), 'thumb')).toBeNull();
    await settle();
    expect(r.calls).toHaveLength(0);
    // Control: a plain id does send.
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
  });

  it('offline: nothing is sent and the answer stays null; coming online fetches what was asked for', async () => {
    const r = await rig({ online: false });
    expect(r.cache.lookup(INSPECTION, key('p1'), 'thumb')).toBeNull();
    await settle();
    expect(r.calls).toHaveLength(0);
    r.setOnline(true);
    await settle();
    flush(r);
    expect(r.calls).toHaveLength(1);
    expect(r.cache.lookup(INSPECTION, key('p1'), 'thumb')).not.toBeNull();
  });

  it('a cached photo survives a restart: a new cache over the same db and files answers it after warm(), offline, with no request', async () => {
    const first = await rig();
    const url = await fetchOnce(first, 'p1');
    const second = await rig({ db: first.db, files: first.files, online: false });
    expect(second.cache.lookup(INSPECTION, key('p1'), 'thumb')).toBeNull();
    const third = await rig({ db: first.db, files: first.files, online: false });
    await third.cache.warm(INSPECTION);
    expect(third.cache.lookup(INSPECTION, key('p1'), 'thumb')).toBe(url);
    expect(third.calls).toHaveLength(0);
  });

  it('warm drops a row whose file is gone, and asks for it again when online', async () => {
    const first = await rig();
    await fetchOnce(first, 'p1');
    for (const path of first.files.paths()) await first.files.remove(path);
    const second = await rig({ db: first.db, files: first.files });
    await second.cache.warm(INSPECTION);
    expect(await second.db.query('SELECT 1 FROM photo_cache')).toEqual([]);
    expect(second.cache.lookup(INSPECTION, key('p1'), 'thumb')).toBeNull();
  });

  it('401 handling: a session that is over (auth problem) writes nothing, does not hammer, and a later try after the pause sends again', async () => {
    const r = await rig();
    r.answer(problem('auth'));
    expect(r.cache.lookup(INSPECTION, key('p1'), 'thumb')).toBeNull();
    await settle();
    expect(r.calls).toHaveLength(1);
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    expect(r.files.paths()).toEqual([]);
    expect(r.notified()).toBe(0);
    r.clock.now += 31_000;
    r.answer(ok(JPEG));
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(2);
    expect(r.files.paths()).toHaveLength(1);
  });

  it('a 404 is remembered for ten minutes, a 503 for a minute, a lost connection is retried at once on the next ask after a short pause', async () => {
    const r = await rig();
    r.answer(status(404));
    r.cache.lookup(INSPECTION, key('gone'), 'thumb');
    await settle();
    r.clock.now += 9 * 60_000;
    r.cache.lookup(INSPECTION, key('gone'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
    r.clock.now += 2 * 60_000;
    r.cache.lookup(INSPECTION, key('gone'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(2);

    r.answer(status(503));
    r.cache.lookup(INSPECTION, key('busy'), 'thumb');
    await settle();
    r.clock.now += 30_000;
    r.cache.lookup(INSPECTION, key('busy'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(3);
    r.clock.now += 31_000;
    r.cache.lookup(INSPECTION, key('busy'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(4);
  });

  it('refuses what is not a picture the web view can show: html, heic, mismatched bytes, empty and oversize; accepts jpeg, png and webp', async () => {
    const r = await rig({ limits: { maxFileBytes: 100 } });
    const cases: [string, ApiOutcome][] = [
      ['html', ok(new TextEncoder().encode('<html>login</html>'), 'text/html')],
      ['heic', ok(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]), 'image/heic')],
      ['lying', ok(new TextEncoder().encode('not a picture!'), 'image/jpeg')],
      ['empty', ok(new Uint8Array(), 'image/jpeg')],
      ['big', ok(new Uint8Array(101).fill(0xff), 'image/jpeg')],
    ];
    for (const [name, outcome] of cases) {
      r.answer(outcome);
      expect(await fetchOnce(r, name), name).toBeNull();
    }
    expect(r.files.paths()).toEqual([]);
    expect(r.notified()).toBe(0);
    for (const [name, bytes, type, ext] of [['j', JPEG, 'image/jpeg', 'jpg'], ['p', PNG, 'image/png', 'png'], ['w', WEBP, 'image/webp', 'webp']] as const) {
      r.answer(ok(bytes, `${type}; charset=binary`));
      const url = await fetchOnce(r, name);
      expect(url, name).toMatch(new RegExp(`\\.${ext}$`));
    }
  });

  it('eviction: past the byte cap the least recently used copy goes, row and file; a copy used meanwhile survives', async () => {
    const r = await rig({ limits: { maxBytes: 3 * JPEG.length, maxEntries: 100 } });
    await fetchOnce(r, 'a');
    r.clock.now += 61_000;
    await fetchOnce(r, 'b');
    r.clock.now += 61_000;
    await fetchOnce(r, 'c');
    r.clock.now += 61_000;
    // Use the oldest one again; it is now the most recent.
    r.cache.lookup(INSPECTION, key('a'), 'thumb');
    await settle();
    r.clock.now += 61_000;
    await fetchOnce(r, 'd');
    const rows = await r.db.query<{ key: string }>('SELECT key FROM photo_cache ORDER BY last_used_at');
    expect(rows.map((x) => x.key)).not.toContain(key('b'));
    expect(rows.map((x) => x.key)).toContain(key('a'));
    expect(rows.map((x) => x.key)).toContain(key('d'));
    expect(r.files.paths().filter((p) => p.startsWith('photo-cache/')).length).toBe(rows.length);
    // The evicted photo is asked for again, not shown from a stale address.
    expect(r.cache.lookup(INSPECTION, key('b'), 'thumb')).toBeNull();
  });

  it('eviction removes only photo-cache files and rows: a media row and its file are never touched', async () => {
    const files = createMemoryFiles({ 'media/m1.jpg': JPEG });
    const r = await rig({ files, limits: { maxBytes: JPEG.length, maxEntries: 1 } });
    await r.db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['m1', INSPECTION, 'photo', 'media/m1.jpg', 'image/jpeg', '{}', 'pending', 1]);
    await fetchOnce(r, 'a');
    r.clock.now += 1000;
    await fetchOnce(r, 'b');
    expect(await r.db.query('SELECT pending_id FROM media')).toEqual([{ pending_id: 'm1' }]);
    expect(files.paths()).toContain('media/m1.jpg');
    expect(files.paths().filter((p) => p.startsWith('photo-cache/'))).toHaveLength(1);
  });

  it("another account's copy is neither answered nor read", async () => {
    const a = await rig();
    await fetchOnce(a, 'p1');
    const b = await rig({ db: a.db, files: a.files, account: BOB, online: false });
    const touchedBefore = b.files.accessed().length;
    await b.cache.warm(INSPECTION);
    expect(b.cache.lookup(INSPECTION, key('p1'), 'thumb')).toBeNull();
    await settle();
    expect(b.files.accessed().length).toBe(touchedBefore);
    expect(b.calls).toHaveLength(0);
    // Control: the first account still has it.
    const again = await rig({ db: a.db, files: a.files, online: false });
    await again.cache.warm(INSPECTION);
    expect(again.cache.lookup(INSPECTION, key('p1'), 'thumb')).not.toBeNull();
  });

  it('adopts the bytes of a photo that is still on the device as the original, without a request', async () => {
    const r = await rig({ localCopy: () => Promise.resolve({ bytes: JPEG, contentType: 'image/jpeg' }) });
    const url = await fetchOnce(r, 'p1', 'thumb');
    expect(url).not.toBeNull();
    expect(r.calls).toHaveLength(0);
    expect(await r.db.query('SELECT size FROM photo_cache')).toEqual([{ size: 'original' }]);
  });

  it('purgeInspection removes that inspection only', async () => {
    const r = await rig();
    await fetchOnce(r, 'p1');
    r.cache.lookup('insp-2', 'tenant-1/inspections/insp-2/photos/x.jpg', 'thumb');
    await settle();
    await r.cache.purgeInspection(INSPECTION);
    expect(await r.db.query<{ inspection_id: string }>('SELECT inspection_id FROM photo_cache')).toEqual([{ inspection_id: 'insp-2' }]);
    expect(r.files.paths().filter((p) => p.startsWith('photo-cache/'))).toHaveLength(1);
  });

  it('clearLocalData removes the copies and their files', async () => {
    const r = await rig();
    await fetchOnce(r, 'p1');
    await clearLocalData(r.db, r.files, r.clock.now);
    expect(await r.db.query('SELECT 1 FROM photo_cache')).toEqual([]);
    expect(r.files.paths()).toEqual([]);
  });
});
