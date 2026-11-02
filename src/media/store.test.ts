import { describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { MAX_MEDIA_BYTES } from './media-types';
import { createMediaStore } from './store';
import { createMediaWorld, INSPECTION, jpegBlob, jpegBytes, photoRecord } from './test-support/fakes';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { neverBlocked } from '../test-support/never-blocked';

const ID = '11111111-2222-4333-8444-555555555555';

/** A Db that records the order of writes and can be told to fail the media insert. */
function spyDb(db: Db, log: string[], failInsert = false): Db {
  const wrapped: Db = {
    execute: (sql) => db.execute(sql),
    query: (sql, params) => db.query(sql, params),
    run: (sql, params) => {
      if (/INSERT/i.test(sql) && /media/i.test(sql)) {
        log.push('row');
        if (failInsert) return Promise.reject(new Error('disk I/O error /private/db/path'));
      }
      return db.run(sql, params);
    },
    transaction: (fn) => db.transaction((tx) => fn(tx)),
  };
  return wrapped;
}

describe('media store: put', () => {
  it('writes the file first, then the row', async () => {
    const world = await createMediaWorld();
    const log: string[] = [];
    const files = createMemoryFiles();
    const original = files.write;
    files.write = (path, data) => {
      log.push('file');
      return original(path, data);
    };
    const store = createMediaStore({ isBlocked: neverBlocked, db: spyDb(world.db, log), files });
    await store.put(photoRecord(ID));
    expect(log).toEqual(['file', 'row']);
    expect(files.paths()).toEqual([`media/${ID}.jpg`]);
    const row = await store.getRow(ID);
    expect(row).toMatchObject({ pendingId: ID, inspectionId: INSPECTION, kind: 'photo', path: `media/${ID}.jpg`, contentType: 'image/jpeg', state: 'pending', attempts: 0, uploadedKey: null, createdAt: 1_000 });
    expect(files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes());
  });

  it('a file write failure throws and leaves no row (positive control: the same record stores once the disk works)', async () => {
    const world = await createMediaWorld();
    const failing = createMemoryFiles();
    failing.failWrites();
    const bad = createMediaStore({ isBlocked: neverBlocked, db: world.db, files: failing });
    await expect(bad.put(photoRecord(ID))).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);

    const good = createMediaStore({ isBlocked: neverBlocked, db: world.db, files: world.files });
    await good.put(photoRecord(ID));
    expect(await world.db.query('SELECT * FROM media')).toHaveLength(1);
  });

  it('a row insert failure after the file was written removes the file', async () => {
    const world = await createMediaWorld();
    const log: string[] = [];
    const store = createMediaStore({ isBlocked: neverBlocked, db: spyDb(world.db, log, true), files: world.files });
    const err: unknown = await store.put(photoRecord(ID)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DB_FAILED' });
    expect(String((err as Error).message)).not.toContain('/private');
    expect(world.files.paths()).toEqual([]);
    expect(world.files.removeCalls()).toEqual([`media/${ID}.jpg`]);
  });

  it('derives the extension from the content type only, never from a name', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('png-1', { type: 'image/png' }));
    await world.store.put(photoRecord('heic-1', { type: 'image/heic' }));
    expect(world.files.paths().sort()).toEqual(['media/heic-1.heic', 'media/png-1.png']);
    // The blob's own name is irrelevant: a File named like a traversal still lands under media/<id>.<ext>.
    const named = new File([jpegBytes()], '../../etc/passwd.sh', { type: 'image/jpeg' });
    await world.store.put({ ...photoRecord('named-1'), blob: named });
    expect(world.files.paths()).toContain('media/named-1.jpg');
    expect(world.files.paths().every((p) => /^media\/[A-Za-z0-9_-]+\.(jpg|png|heic)$/.test(p))).toBe(true);
  });

  it.each([
    ['text/html'],
    ['application/octet-stream'],
    ['image/svg+xml'],
    ['image/gif'],
    [''],
  ])('refuses content type %j and writes nothing', async (type) => {
    const world = await createMediaWorld();
    await expect(world.store.put(photoRecord(ID, { type }))).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    expect(world.files.writeCalls()).toEqual([]);
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
    // Control: the allowed type goes through on the same world.
    await world.store.put(photoRecord(ID));
    expect(world.files.writeCalls()).toHaveLength(1);
  });

  it('refuses an empty or oversized file before writing', async () => {
    const world = await createMediaWorld();
    await expect(world.store.put({ ...photoRecord(ID), blob: new Blob([], { type: 'image/jpeg' }) })).rejects.toMatchObject({ code: 'EMPTY' });
    const big = { ...photoRecord(ID), blob: new Blob([new Uint8Array(MAX_MEDIA_BYTES + 1)], { type: 'image/jpeg' }) };
    await expect(world.store.put(big)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(world.files.writeCalls()).toEqual([]);
    const exact = { ...photoRecord(ID), blob: new Blob([new Uint8Array(MAX_MEDIA_BYTES)], { type: 'image/jpeg' }) };
    await expect(world.store.put(exact)).resolves.toBeUndefined();
  });

  it.each([
    ['../escape'],
    ['a/b'],
    ['a\\b'],
    [''],
    ['x'.repeat(65)],
    ['a b'],
    ['..'],
    ['a:b'],
  ])('refuses pending id %j and touches nothing', async (id) => {
    const world = await createMediaWorld();
    await expect(world.store.put(photoRecord(id))).rejects.toMatchObject({ code: 'INVALID_ID' });
    await expect(world.store.get(id)).resolves.toBeNull();
    expect(world.files.writeCalls()).toEqual([]);
    // Control: a well-formed id is accepted.
    await world.store.put(photoRecord('ok-id_1'));
    expect(world.files.paths()).toEqual(['media/ok-id_1.jpg']);
  });

  it('refuses an invalid inspection id', async () => {
    const world = await createMediaWorld();
    await expect(world.store.put(photoRecord(ID, { inspectionId: '../x' }))).rejects.toMatchObject({ code: 'INVALID_ID' });
    expect(world.files.writeCalls()).toEqual([]);
  });

  it('stores a defect photo (it is kept on the device, unlike on the web), and refuses a defect meta that does not name its defect', async () => {
    const world = await createMediaWorld();
    const defect = { ...photoRecord(ID), meta: { targetType: 'defect' as const, findingKey: 'k', itemId: 'i', customId: 'c', defectKind: 'custom' as const } };
    await world.store.put(defect);
    expect(world.files.paths()).toEqual([`media/${ID}.jpg`]);
    const incomplete = { ...photoRecord('other-id'), meta: { targetType: 'defect', findingKey: 'k', itemId: 'i', defectKind: 'custom' } } as unknown as Parameters<typeof world.store.put>[0];
    await expect(world.store.put(incomplete)).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    expect(world.files.paths()).toEqual([`media/${ID}.jpg`]);
  });

  it('a second put for an existing pending id keeps the first file and row (idempotent)', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID, { seed: 1 }));
    await world.store.markState(ID, 'uploading', { attempts: 1 });
    await world.store.put(photoRecord(ID, { seed: 2 }));
    expect(await world.db.query('SELECT * FROM media')).toHaveLength(1);
    expect(world.files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes(1));
    expect((await world.store.getRow(ID))?.state).toBe('uploading');
    // A put that would move the id to another inspection is a conflict, not a silent overwrite.
    await expect(world.store.put(photoRecord(ID, { inspectionId: 'other' }))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(world.files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes(1));
  });

  it('two concurrent puts of one id store one file and one row, and a failing duplicate never deletes the first file', async () => {
    const world = await createMediaWorld();
    const results = await Promise.allSettled([world.store.put(photoRecord(ID, { seed: 1 })), world.store.put(photoRecord(ID, { seed: 2 }))]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await world.db.query('SELECT * FROM media')).toHaveLength(1);
    expect(world.files.paths()).toEqual([`media/${ID}.jpg`]);
    expect(world.files.bytes(`media/${ID}.jpg`)).toEqual(jpegBytes(1));
  });
});

describe('media store: get, list, objectUrl, delete', () => {
  it('returns records in the field-ui shape without reading the file back', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('b', { createdAt: 2_000 }));
    await world.store.put(photoRecord('a', { createdAt: 1_000 }));
    await world.store.put(photoRecord('c', { createdAt: 3_000, inspectionId: 'other' }));
    const reads: string[] = [];
    const original = world.files.read;
    world.files.read = (p) => {
      reads.push(p);
      return original(p);
    };
    const all = await world.store.list();
    expect(all.map((r) => r.pendingId)).toEqual(['a', 'b', 'c']);
    expect((await world.store.list(INSPECTION)).map((r) => r.pendingId)).toEqual(['a', 'b']);
    const one = await world.store.get('a');
    expect(one).toMatchObject({ pendingId: 'a', inspectionId: INSPECTION, kind: 'photo', createdAt: 1_000, meta: { targetType: 'item', findingKey: '_default:s1:i1', itemId: 'i1' } });
    expect(one?.blob.type).toBe('image/jpeg');
    expect(reads).toEqual([]);
    expect(await world.store.get('missing')).toBeNull();
  });

  it('serves the display url for the stored file, or null when the row is gone', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    expect(await world.store.objectUrl(ID)).toBe(`https://localhost/_capacitor_file_/media/${ID}.jpg`);
    expect(await world.store.objectUrl('nope')).toBeNull();
    expect(await world.store.objectUrl('../x')).toBeNull();
  });

  it('delete removes the file and the row, and is a no-op for an unknown id', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    await world.store.delete(ID);
    expect(world.files.paths()).toEqual([]);
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
    await expect(world.store.delete(ID)).resolves.toBeUndefined();
  });

  it('delete keeps the row when the file cannot be removed (so a later pass can retry), and completes once the file is gone', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    world.files.failRemoveFor(`media/${ID}.jpg`);
    await expect(world.store.delete(ID)).rejects.toMatchObject({ code: 'DELETE_FAILED' });
    expect(await world.db.query('SELECT * FROM media')).toHaveLength(1);
    // The file vanished by other means (a failed remove after the bytes were already gone): the row can go.
    const files = createMemoryFiles();
    const store = createMediaStore({ isBlocked: neverBlocked, db: world.db, files });
    await expect(store.delete(ID)).resolves.toBeUndefined();
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
  });

  it('skips rows whose state, path or kind the store would not have written, without throwing', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('good-1'));
    const insert = 'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)';
    const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
    await world.db.run(insert, ['bad-state', INSPECTION, 'photo', 'media/bad-state.jpg', 'image/jpeg', meta, 'exploded', 0, 5]);
    await world.db.run(insert, ['bad-path', INSPECTION, 'photo', '../../etc/passwd', 'image/jpeg', meta, 'pending', 0, 5]);
    await world.db.run(insert, ['bad-kind', INSPECTION, 'audio', 'media/bad-kind.jpg', 'image/jpeg', meta, 'pending', 0, 5]);
    await world.db.run(insert, ['bad-meta', INSPECTION, 'photo', 'media/bad-meta.jpg', 'image/jpeg', '{not json', 'pending', 0, 5]);
    await world.db.run(insert, ['../bad-id', INSPECTION, 'photo', 'media/../bad-id.jpg', 'image/jpeg', meta, 'pending', 0, 5]);
    // Unreadable meta does not stop the upload (the upload never reads it), so the row is listed for the uploader
    // but is not offered to the editor as a record.
    expect((await world.store.listRows()).map((r) => r.pendingId)).toEqual(['bad-meta', 'good-1']);
    expect((await world.store.list()).map((r) => r.pendingId)).toEqual(['good-1']);
    expect(await world.store.getRow('bad-state')).toBeNull();
    expect(await world.store.get('bad-meta')).toBeNull();
    await expect(world.store.markState('good-1', 'exploded' as never)).rejects.toThrow('Invalid media state');
  });

  it('filters rows by state and caps a huge list', async () => {
    const world = await createMediaWorld();
    for (let i = 0; i < 12; i += 1) await world.store.put(photoRecord(`p-${String(i).padStart(2, '0')}`, { createdAt: i }));
    await world.store.markState('p-03', 'failed', { attempts: 2 });
    expect((await world.store.listRows({ states: ['failed'] })).map((r) => r.pendingId)).toEqual(['p-03']);
    expect(await world.store.listRows({ limit: 5 })).toHaveLength(5);
    expect(await world.store.listRows({ states: [] })).toEqual([]);
  });

  it('pages with a keyset cursor, filters by kind, and leaves out rows that are given up on', async () => {
    const world = await createMediaWorld();
    for (let i = 0; i < 6; i += 1) await world.store.put(photoRecord(`p-${String(i)}`, { createdAt: 10 + Math.floor(i / 2) }));
    await world.store.put({
      pendingId: 'crop-1', inspectionId: INSPECTION, kind: 'crop', blob: jpegBlob(), createdAt: 1,
      meta: { findingKey: 'k', itemId: 'i', photoIndex: 0, photoKey: 'pk', crop: {} as never },
    });
    const seen: string[] = [];
    let after: { createdAt: number; pendingId: string } | undefined;
    for (;;) {
      const page = await world.store.listRows({ kinds: ['photo'], limit: 4, ...(after ? { after } : {}) });
      const last = page[page.length - 1];
      if (!last) break;
      seen.push(...page.map((r) => r.pendingId));
      after = { createdAt: last.createdAt, pendingId: last.pendingId };
    }
    // Same created_at for two rows: the cursor still visits each exactly once, in order.
    expect(seen).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5']);

    await world.store.markState('p-1', 'failed', { attempts: 8 });
    await world.store.markState('p-2', 'failed', { attempts: 7 });
    await world.store.markState('p-3', 'uploading', { attempts: 8 });
    const live = (await world.store.listRows({ kinds: ['photo'], skipGivenUpAt: 8 })).map((r) => r.pendingId);
    expect(live).toEqual(['p-0', 'p-2', 'p-3', 'p-4', 'p-5']);
    await expect(world.store.listRows({ kinds: ['audio' as never] })).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    // The cursor is only ever bound, and may name a corrupt row's id, so only its shape is checked.
    await expect(world.store.listRows({ after: { createdAt: 1, pendingId: '' } })).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    await expect(world.store.listRows({ after: { createdAt: 1, pendingId: 'x'.repeat(600) } })).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    await expect(world.store.listRows({ after: { createdAt: Number.NaN, pendingId: 'x' } })).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    await expect(world.store.listRows({ after: { createdAt: 1, pendingId: '../x' } })).resolves.toEqual(expect.any(Array));
  });

  it('markState updates the state, attempts and uploaded key; reports whether a row matched', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    expect(await world.store.markState(ID, 'uploaded', { attempts: 3, uploadedKey: 't/inspections/i/photos/x.jpg' })).toBe(true);
    expect(await world.store.getRow(ID)).toMatchObject({ state: 'uploaded', attempts: 3, uploadedKey: 't/inspections/i/photos/x.jpg' });
    expect(await world.store.markState('missing', 'failed')).toBe(false);
  });

  it('markState with ifState is one conditional UPDATE: it matches only a row in that state and changes nothing otherwise (f)', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord(ID));
    await world.store.markState(ID, 'failed', { attempts: 5 });
    expect(await world.store.markState(ID, 'pending', { attempts: 0, ifState: 'uploaded' })).toBe(false);
    expect(await world.store.getRow(ID)).toMatchObject({ state: 'failed', attempts: 5 });
    expect(await world.store.markState(ID, 'pending', { attempts: 0, ifState: 'failed' })).toBe(true);
    expect(await world.store.getRow(ID)).toMatchObject({ state: 'pending', attempts: 0 });
    await expect(world.store.markState(ID, 'pending', { ifState: 'exploded' as never })).rejects.toThrow();
  });

  it('stores crop and annotate records with their meta and reads them back', async () => {
    const world = await createMediaWorld();
    const crop = {
      pendingId: 'crop-1',
      inspectionId: INSPECTION,
      kind: 'crop' as const,
      blob: jpegBlob(),
      createdAt: 5,
      meta: { findingKey: 'k', itemId: 'i', photoIndex: 0, photoKey: 'pk', crop: { x: 1 } as never },
    };
    await world.store.put(crop);
    expect((await world.store.get('crop-1'))?.meta).toEqual(crop.meta);
    const bad = { ...crop, pendingId: 'crop-2', meta: { findingKey: 'k' } as never };
    await expect(world.store.put(bad)).rejects.toMatchObject({ code: 'INVALID_RECORD' });
  });
});

describe('media store: paging counts raw rows, not valid ones (b)', () => {
  const meta = JSON.stringify({ targetType: 'item', findingKey: 'k', itemId: 'i' });
  const insert = 'INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?,?,?,?,?,?,?,?,?)';

  it('a page made only of corrupt rows still has a cursor, and following it reaches the valid rows behind them', async () => {
    const world = await createMediaWorld();
    await world.db.run(insert, ['bad-1', INSPECTION, 'photo', 'media/bad-1.jpg', 'image/jpeg', meta, 'exploded', 0, 1]);
    await world.db.run(insert, ['bad/2', INSPECTION, 'photo', 'media/bad-2.jpg', 'image/jpeg', meta, 'pending', 0, 2]);
    await world.store.put(photoRecord('good-1', { createdAt: 3 }));
    await world.store.put(photoRecord('good-2', { createdAt: 4 }));

    const first = await world.store.listRowsPage({ limit: 2 });
    expect(first.rows).toEqual([]);
    expect(first.rawCount).toBe(2);
    expect(first.next).toEqual({ createdAt: 2, pendingId: 'bad/2' });

    const seen: string[] = [];
    let after = first.next;
    while (after !== null) {
      const page = await world.store.listRowsPage({ limit: 2, after });
      seen.push(...page.rows.map((row) => row.pendingId));
      after = page.rawCount < 2 ? null : page.next;
    }
    expect(seen).toEqual(['good-1', 'good-2']);
  });

  it('control: listRows still leaves corrupt rows out and a page of valid rows reports its own last row as the cursor', async () => {
    const world = await createMediaWorld();
    await world.db.run(insert, ['bad-1', INSPECTION, 'photo', 'media/bad-1.jpg', 'image/jpeg', meta, 'exploded', 0, 1]);
    await world.store.put(photoRecord('good-1', { createdAt: 3 }));
    expect((await world.store.listRows()).map((row) => row.pendingId)).toEqual(['good-1']);
    const page = await world.store.listRowsPage({});
    expect(page).toMatchObject({ rawCount: 2, next: { createdAt: 3, pendingId: 'good-1' } });
    expect(page.rows).toHaveLength(1);
  });
});

describe('media store: onStored', () => {
  it('is called once for a new row, not for a repeated put and not for a failed one', async () => {
    const world = await createMediaWorld();
    const stored: string[] = [];
    const store = createMediaStore({ isBlocked: neverBlocked, db: world.db, files: world.files, onStored: (id) => stored.push(id) });
    await store.put(photoRecord('p1'));
    await store.put(photoRecord('p1'));
    expect(stored).toEqual(['p1']);
    world.files.failWrites();
    await expect(store.put(photoRecord('p2'))).rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(stored).toEqual(['p1']);
  });

  it('a throwing callback does not fail the put', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ isBlocked: neverBlocked, db: world.db, files: world.files, onStored: () => { throw new Error('listener'); } });
    await expect(store.put(photoRecord('p1'))).resolves.toBeUndefined();
    expect(await store.getRow('p1')).not.toBeNull();
  });
});
