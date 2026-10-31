import { describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { accountKey } from '../offline/outbox';
import type { LocalPhotoCopy } from './photo-cache';
import { ALICE, BOB, INSPECTION, JPEG, fetchOnce, flush, key, ok, rig, settle } from './test-support/photo-cache-rig';

const HEIC = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
const local = (bytes: Uint8Array = JPEG): LocalPhotoCopy => ({ bytes, contentType: 'image/jpeg' });
const cacheWrites = (files: { writeCalls(): string[] }): string[] => files.writeCalls().filter((p) => p.startsWith('photo-cache/'));

async function sha(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((v) => v.toString(16).padStart(2, '0')).join('');
}

describe('photo cache: one writer per file', () => {
  it('thumb and view asked at once for a photo that is on the device write its original once', async () => {
    const r = await rig({ localCopy: () => Promise.resolve(local()) });
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    r.cache.lookup(INSPECTION, key('p1'), 'view');
    await settle();
    flush(r);
    expect(cacheWrites(r.files)).toHaveLength(1);
    expect(r.cache.lookup(INSPECTION, key('p1'), 'thumb')).not.toBeNull();
    expect(r.cache.lookup(INSPECTION, key('p1'), 'view')).not.toBeNull();
    expect(r.calls).toHaveLength(0);
  });

  it('prime racing a lookup writes once; control: two different photos are two writes', async () => {
    const r = await rig({ localCopy: () => Promise.resolve(local()) });
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await r.cache.prime(INSPECTION, [key('p1'), key('p2')]);
    await settle();
    expect(cacheWrites(r.files)).toHaveLength(2);
  });
});

describe('photo cache: prime', () => {
  it('opens the device rows once for all keys, reads each file, and reports the keys it cannot show (a HEIC)', async () => {
    let opens = 0;
    let singles = 0;
    const reader = Object.assign(
      () => {
        singles += 1;
        return Promise.resolve(null);
      },
      {
        open: () => {
          opens += 1;
          return Promise.resolve((k: string) => Promise.resolve(k === key('heic') ? local(HEIC) : local()));
        },
      },
    );
    const r = await rig({ localCopy: reader });
    const names = ['a', 'b', 'c', 'd', 'heic'];
    const uncached = await r.cache.prime(INSPECTION, names.map(key));
    expect(opens).toBe(1);
    expect(singles).toBe(0);
    expect(uncached).toEqual([key('heic')]);
    expect(cacheWrites(r.files)).toHaveLength(4);
  });

  it('without any way to read device files, every key is reported', async () => {
    const r = await rig();
    expect(await r.cache.prime(INSPECTION, [key('a')])).toEqual([key('a')]);
  });
});

describe('photo cache: orphan sweep', () => {
  const hex = (n: number): string => n.toString(16).padStart(64, '0');

  it('removes old cache files with no row, and keeps young ones, referenced ones, other accounts and other names', async () => {
    const r = await rig();
    r.clock.now = 2_000_000_000_000;
    const old = 1_500_000_000_000;
    const put = async (path: string, mtime: number | null): Promise<void> => {
      await r.files.write(path, JPEG);
      r.files.setMtime(path, mtime);
    };
    await put(`photo-cache/${hex(1)}.jpg`, old); // orphan
    await put(`photo-cache/${hex(2)}.webp`, old); // orphan
    await put(`photo-cache/${hex(3)}.jpg`, r.clock.now - 10_000); // young: a store may be in flight
    await put(`photo-cache/${hex(4)}.jpg`, old); // referenced
    await put(`photo-cache/${hex(5)}.png`, old); // another account's
    await put('photo-cache/notes.txt', old);
    await put(`photo-cache/${hex(6)}.jpg`, null); // age unknown: kept
    for (const [n, account] of [[4, accountKey(ALICE)], [5, accountKey(BOB)]] as const) {
      await r.db.run('INSERT INTO photo_cache (hash, account_key, inspection_id, key, size, path, bytes, content_type, last_used_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [hex(n), account, INSPECTION, `k${String(n)}`, 'thumb', `photo-cache/${hex(n)}.${n === 5 ? 'png' : 'jpg'}`, 3, 'image/jpeg', 1, 1]);
    }
    await r.files.write('media/m1.jpg', JPEG);
    r.files.setMtime('media/m1.jpg', old);
    expect(await r.cache.sweepOrphans()).toBe(2);
    expect(r.files.paths().filter((p) => p.startsWith('photo-cache/')).sort()).toEqual([`photo-cache/${hex(3)}.jpg`, `photo-cache/${hex(4)}.jpg`, `photo-cache/${hex(5)}.png`, `photo-cache/${hex(6)}.jpg`, 'photo-cache/notes.txt']);
    expect(r.files.paths()).toContain('media/m1.jpg');
  });
});

describe('photo cache: eviction and errors', () => {
  it('eviction never deletes a file whose recorded path is not a cache file name', async () => {
    const r = await rig({ limits: { maxEntries: 1, maxBytes: 1_000_000 } });
    await r.files.write('media/m1.jpg', JPEG);
    await r.db.run('INSERT INTO photo_cache (hash, account_key, inspection_id, key, size, path, bytes, content_type, last_used_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['h0', accountKey(ALICE), INSPECTION, 'old', 'thumb', 'media/m1.jpg', 3, 'image/jpeg', 1, 1]);
    await fetchOnce(r, 'p1');
    expect(await r.db.query('SELECT 1 FROM photo_cache WHERE hash = ?', ['h0'])).toEqual([]);
    expect(r.files.paths()).toContain('media/m1.jpg');
  });

  it('a failing eviction is reported, and the stored copy is still announced and not blocked', async () => {
    const real = await createSqlJsDb();
    await migrate(real, 0);
    const db: Db = { ...real, query: (sql, params) => (/sum\(bytes\)/.test(sql) ? Promise.reject(new Error('evict boom')) : real.query(sql, params)) };
    const errors: unknown[] = [];
    const r = await rig({ db, onError: (e) => errors.push(e) });
    const url = await fetchOnce(r, 'p1');
    expect(url).not.toBeNull();
    expect(r.notified()).toBe(1);
    expect(errors).toHaveLength(1);
    r.cache.lookup(INSPECTION, key('p1'), 'thumb');
    await settle();
    expect(r.calls).toHaveLength(1);
  });

  it('a type the web view cannot show is reported once, by type and without a path', async () => {
    const errors: unknown[] = [];
    const r = await rig({ answerWith: ok(HEIC, 'image/heic'), onError: (e) => errors.push(e) });
    await fetchOnce(r, 'a');
    await fetchOnce(r, 'b');
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('image/heic');
    expect(String((errors[0] as Error).message)).not.toContain('tenant-1');
  });
});

describe('photo cache: more photos than the old memory limit', () => {
  it('every stored copy answers at once; none is pushed out by the others', async () => {
    const N = 600;
    const first = await rig({ limits: { maxEntries: 2000 } });
    for (let i = 0; i < N; i += 1) {
      const k = key(`m${String(i)}`);
      const hash = await sha(`${accountKey(ALICE)}|${INSPECTION}|${k}|thumb`);
      await first.files.write(`photo-cache/${hash}.jpg`, JPEG);
      await first.db.run('INSERT INTO photo_cache (hash, account_key, inspection_id, key, size, path, bytes, content_type, last_used_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [hash, accountKey(ALICE), INSPECTION, k, 'thumb', `photo-cache/${hash}.jpg`, 12, 'image/jpeg', 1, 1]);
    }
    const second = await rig({ db: first.db, files: first.files, limits: { maxEntries: 2000 } });
    for (let i = 0; i < N; i += 1) second.cache.lookup(INSPECTION, key(`m${String(i)}`), 'thumb');
    for (let round = 0; round < 200; round += 1) {
      await settle();
      if (second.cache.lookup(INSPECTION, key(`m${String(N - 1)}`), 'thumb') !== null) break;
    }
    await settle();
    let answered = 0;
    for (let i = 0; i < N; i += 1) if (second.cache.lookup(INSPECTION, key(`m${String(i)}`), 'thumb') !== null) answered += 1;
    expect(answered).toBe(N);
    expect(second.calls).toHaveLength(0);
  }, 120_000);
});
