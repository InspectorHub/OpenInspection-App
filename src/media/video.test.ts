import { describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { sweepOrphanFiles, ORPHAN_MIN_AGE_MS } from './sweep';
import { resolveUploadUrl } from './native-uploader';
import { MAX_VIDEO_BYTES } from './media-types';
import { createMediaStore } from './store';
import { createMediaWorld, INSPECTION, jpegBlob, photoRecord } from './test-support/fakes';
import { STREAM_HOST, videoBytes, videoRecord } from './test-support/video-fakes';
import {
  blobVideoSource,
  checkFreeSpace,
  createRealDiskSpace,
  createStorageEstimateDiskSpace,
  isExpectedVideoKey,
  MIN_FREE_BYTES,
  resolveVideoUploadUrl,
  STREAM_UPLOAD_HOST,
  VIDEO_MAX_SECONDS,
  videoRefFromKey,
} from './video';
import { neverBlocked } from '../test-support/never-blocked';

const ID = 'vid-aaaa-1111';
const ORIGIN = 'https://oi.example.test';
const R2_KEY = `tenant-1/inspections/${INSPECTION}/videos/media-1.mp4`;

function failingInsertDb(db: Db): Db {
  return {
    execute: (sql) => db.execute(sql),
    query: (sql, params) => db.query(sql, params),
    run: (sql, params) => (/INSERT/i.test(sql) ? Promise.reject(new Error('disk I/O error /private/db/path')) : db.run(sql, params)),
    transaction: (fn) => db.transaction((tx) => fn(tx)),
  };
}

describe('video store: putVideo', () => {
  it('writes media/<pendingId>.mp4 first, then a video row in state pending, and the bytes are the clip', async () => {
    const world = await createMediaWorld();
    const log: string[] = [];
    const original = world.files.writeStream;
    world.files.writeStream = (path, chunks) => {
      log.push('file');
      return original(path, chunks);
    };
    const db: Db = {
      execute: (sql) => world.db.execute(sql),
      query: (sql, params) => world.db.query(sql, params),
      run: (sql, params) => {
        if (/INSERT/i.test(sql)) log.push('row');
        return world.db.run(sql, params);
      },
      transaction: (fn) => world.db.transaction((tx) => fn(tx)),
    };
    const store = createMediaStore({ isBlocked: neverBlocked, db, files: world.files });
    await store.putVideo(videoRecord(ID, { durationSec: 12 }));
    expect(log).toEqual(['file', 'row']);
    expect(world.files.paths()).toEqual([`media/${ID}.mp4`]);
    expect(world.files.bytes(`media/${ID}.mp4`)).toEqual(videoBytes());
    expect(await store.getRow(ID)).toMatchObject({
      pendingId: ID,
      inspectionId: INSPECTION,
      kind: 'video',
      path: `media/${ID}.mp4`,
      contentType: 'video/mp4',
      state: 'pending',
      attempts: 0,
      uploadedKey: null,
    });
    expect(JSON.parse((await store.getRow(ID))?.meta ?? '{}')).toEqual({ itemId: 'i1', durationSec: 12 });
  });

  it('stores video/quicktime as .mov and refuses webm, an image type and an empty type (positive control: mp4 above)', async () => {
    const world = await createMediaWorld();
    await world.store.putVideo(videoRecord('mov-1', { type: 'video/quicktime' }));
    expect(world.files.paths()).toEqual(['media/mov-1.mov']);
    for (const type of ['video/webm', 'image/jpeg', '']) {
      await expect(world.store.putVideo(videoRecord('bad-1', { type }))).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    }
    expect(world.files.paths()).toEqual(['media/mov-1.mov']);
    expect(await world.store.getRow('bad-1')).toBeNull();
  });

  it('the photo put still refuses a video type, and putVideo is the only way a video gets in', async () => {
    const world = await createMediaWorld();
    await expect(world.store.put(photoRecord('p-1', { type: 'video/mp4' }))).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    await world.store.put(photoRecord('p-2'));
    expect((await world.store.getRow('p-2'))?.kind).toBe('photo');
    expect(jpegBlob().type).toBe('image/jpeg');
  });

  it('a file write failure leaves no row, a full disk is reported as DISK_FULL and nothing is left (positive control: a working disk stores it)', async () => {
    const world = await createMediaWorld();
    const full = createMemoryFiles();
    full.failWrites();
    const bad = createMediaStore({ isBlocked: neverBlocked, db: world.db, files: full });
    await expect(bad.putVideo(videoRecord(ID))).rejects.toMatchObject({ code: 'DISK_FULL' });
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
    expect(full.paths()).toEqual([]);

    await world.store.putVideo(videoRecord(ID));
    expect(await world.db.query('SELECT * FROM media')).toHaveLength(1);
  });

  it('a failure of the source stream is a READ_FAILED with no row and no file', async () => {
    const world = await createMediaWorld();
    const rec = videoRecord(ID);
    const failing = {
      ...rec,
      source: {
        ...rec.source,
        chunks: async function* chunks() {
          yield new Uint8Array(16);
          await Promise.resolve();
          throw new Error('camera gone /private/path');
        },
      },
    };
    const err: unknown = await world.store.putVideo(failing).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'READ_FAILED' });
    expect(JSON.stringify(err)).not.toContain('private');
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
  });

  it('a row insert failure after the file was written removes the file', async () => {
    const world = await createMediaWorld();
    const store = createMediaStore({ isBlocked: neverBlocked, db: failingInsertDb(world.db), files: world.files });
    const err: unknown = await store.putVideo(videoRecord(ID)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'DB_FAILED' });
    expect(world.files.paths()).toEqual([]);
    expect(world.files.removeCalls()).toEqual([`media/${ID}.mp4`]);
  });

  it('refuses a clip over the engine limit before anything is written, and accepts one of exactly that size on the declared check', async () => {
    const world = await createMediaWorld();
    expect(MAX_VIDEO_BYTES).toBe(200 * 1024 * 1024);
    await expect(world.store.putVideo(videoRecord(ID, { declaredSize: MAX_VIDEO_BYTES + 1 }))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(world.files.writeCalls()).toEqual([]);
    // The limit is not exceeded by one byte less: the declared size passes and the (short) stream is what fails.
    await expect(world.store.putVideo(videoRecord(ID, { declaredSize: MAX_VIDEO_BYTES }))).rejects.toMatchObject({ code: 'READ_FAILED' });
    expect(world.files.paths()).toEqual([]);
  });

  it('a stream that delivers more than it declared is cut off and removed, and one that delivers less is removed too', async () => {
    const world = await createMediaWorld();
    await expect(world.store.putVideo(videoRecord('lie-more', { length: 96, declaredSize: 48 }))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(world.store.putVideo(videoRecord('lie-less', { length: 48, declaredSize: 96 }))).rejects.toMatchObject({ code: 'READ_FAILED' });
    expect(world.files.paths()).toEqual([]);
    expect(await world.db.query('SELECT * FROM media')).toEqual([]);
    await world.store.putVideo(videoRecord('honest', { length: 48, declaredSize: 48 }));
    expect(world.files.paths()).toEqual(['media/honest.mp4']);
  });

  it('refuses an empty clip, an over-long clip and a nonsense duration; a clip of exactly the cap is stored', async () => {
    const world = await createMediaWorld();
    await expect(world.store.putVideo(videoRecord('empty', { length: 0, declaredSize: 0 }))).rejects.toMatchObject({ code: 'EMPTY' });
    expect(VIDEO_MAX_SECONDS).toBe(30);
    await expect(world.store.putVideo(videoRecord('long', { durationSec: VIDEO_MAX_SECONDS + 1 }))).rejects.toMatchObject({ code: 'TOO_LONG' });
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      await expect(world.store.putVideo(videoRecord('odd', { durationSec: bad }))).rejects.toMatchObject({ code: 'INVALID_RECORD' });
    }
    await world.store.putVideo(videoRecord('edge', { durationSec: VIDEO_MAX_SECONDS }));
    expect(await world.store.getRow('edge')).not.toBeNull();
    expect(world.files.paths()).toEqual(['media/edge.mp4']);
  });

  it('a repeated putVideo keeps the first file and row (a retried save never touches a file that may be uploading); another inspection under the id conflicts', async () => {
    const world = await createMediaWorld();
    await world.store.putVideo(videoRecord(ID, { seed: 1 }));
    await world.store.putVideo(videoRecord(ID, { seed: 2 }));
    expect(world.files.writeCalls()).toHaveLength(1);
    expect(world.files.bytes(`media/${ID}.mp4`)).toEqual(videoBytes(1));
    await expect(world.store.putVideo(videoRecord(ID, { inspectionId: 'other-insp' }))).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses ids that could name another place, writing nothing (positive control: a plain id is stored)', async () => {
    const world = await createMediaWorld();
    for (const bad of ['../evil', 'a/b', 'a\\b', '', 'x'.repeat(65)]) {
      await expect(world.store.putVideo(videoRecord(bad))).rejects.toMatchObject({ code: 'INVALID_ID' });
    }
    await expect(world.store.putVideo(videoRecord(ID, { inspectionId: '../x' }))).rejects.toMatchObject({ code: 'INVALID_ID' });
    expect(world.files.writeCalls()).toEqual([]);
    await world.store.putVideo(videoRecord(ID));
    expect(world.files.writeCalls()).toEqual([`media/${ID}.mp4`]);
  });

  it('keeps video rows out of the editor-facing list and get (the editor knows only photos), and lists them by kind', async () => {
    const world = await createMediaWorld();
    await world.store.put(photoRecord('photo-1'));
    await world.store.putVideo(videoRecord(ID));
    expect((await world.store.list(INSPECTION)).map((r) => r.pendingId)).toEqual(['photo-1']);
    expect(await world.store.get(ID)).toBeNull();
    expect((await world.store.get('photo-1'))?.pendingId).toBe('photo-1');
    expect((await world.store.listRows({ kinds: ['video'] })).map((r) => r.pendingId)).toEqual([ID]);
    expect((await world.store.listRows({ kinds: ['photo'] })).map((r) => r.pendingId)).toEqual(['photo-1']);
  });

  it('treats a row whose kind and content type disagree, or whose path or key is forged, as no row at all', async () => {
    const world = await createMediaWorld();
    const meta = JSON.stringify({ itemId: 'i1' });
    const insert = (id: string, kind: string, type: string, path: string, key: string | null) =>
      world.db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, uploaded_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, INSPECTION, kind, path, type, meta, 'pending', 0, key, 1]);
    await insert('v-ok', 'video', 'video/mp4', 'media/v-ok.mp4', null);
    await insert('v-img', 'video', 'image/jpeg', 'media/v-img.jpg', null);
    await insert('v-path', 'video', 'video/mp4', 'media/other.mp4', null);
    await insert('v-key', 'video', 'video/mp4', 'media/v-key.mp4', '../../etc/passwd');
    await insert('p-vid', 'photo', 'video/mp4', 'media/p-vid.mp4', null);
    expect((await world.store.listRows()).map((r) => r.pendingId)).toEqual(['v-ok']);
    expect(await world.store.getRow('v-img')).toBeNull();
    expect(await world.store.getRow('v-key')).toBeNull();
  });

  it('the orphan sweep recognises .mp4 and .mov: an old orphan is removed, one with a row is kept', async () => {
    const world = await createMediaWorld();
    const clock = createManualClock(1_800_000_000_000);
    await world.store.putVideo(videoRecord('has-row'));
    world.files.setMtime('media/has-row.mp4', 0);
    await world.files.write('media/orphan.mp4', videoBytes());
    await world.files.write('media/orphan2.mov', videoBytes());
    world.files.setMtime('media/orphan.mp4', 1_800_000_000_000 - ORPHAN_MIN_AGE_MS - 1);
    world.files.setMtime('media/orphan2.mov', 1_800_000_000_000 - ORPHAN_MIN_AGE_MS - 1);
    expect(await sweepOrphanFiles({ db: world.db, files: world.files, clock })).toEqual({ removed: 2, failed: 0 });
    expect(world.files.paths()).toEqual(['media/has-row.mp4']);
  });

  it('blobVideoSource streams a Blob in bounded pieces and reports its size and type', async () => {
    const blob = new Blob([videoBytes(7, 3 * 1024 * 1024 + 5)], { type: 'video/mp4' });
    const source = blobVideoSource(blob);
    expect(source.size).toBe(blob.size);
    expect(source.contentType).toBe('video/mp4');
    const sizes: number[] = [];
    for await (const chunk of source.chunks()) sizes.push(chunk.length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(blob.size);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1024 * 1024);
    expect(sizes.length).toBeGreaterThan(3);
  });
});

describe('checkFreeSpace', () => {
  const authoritative = (free: number | null) => ({ authoritative: true as const, freeBytes: () => Promise.resolve(free) });
  const advisory = (free: number | null) => ({ freeBytes: () => Promise.resolve(free) });

  it('an authoritative port refuses below the threshold, allows at and above it (the boundary), and the default threshold is 1 GiB', async () => {
    expect(MIN_FREE_BYTES).toBe(1024 * 1024 * 1024);
    expect(await checkFreeSpace(authoritative(MIN_FREE_BYTES - 1))).toEqual({ ok: false, code: 'LOW_SPACE', freeBytes: MIN_FREE_BYTES - 1 });
    expect(await checkFreeSpace(authoritative(MIN_FREE_BYTES))).toEqual({ ok: true, freeBytes: MIN_FREE_BYTES });
    expect(await checkFreeSpace(authoritative(5 * MIN_FREE_BYTES))).toEqual({ ok: true, freeBytes: 5 * MIN_FREE_BYTES });
    expect(await checkFreeSpace(authoritative(99), 100)).toMatchObject({ ok: false, code: 'LOW_SPACE' });
    expect(await checkFreeSpace(authoritative(100), 100)).toMatchObject({ ok: true });
  });

  it('a port that is not authoritative never refuses: a low reading is only the fixed warning SPACE_UNKNOWN (control: the same reading refuses when authoritative)', async () => {
    const unknown = { ok: true, freeBytes: null, warning: 'SPACE_UNKNOWN' };
    expect(await checkFreeSpace(authoritative(0))).toMatchObject({ ok: false, code: 'LOW_SPACE' });
    expect(await checkFreeSpace(advisory(0))).toEqual(unknown);
    expect(await checkFreeSpace(advisory(MIN_FREE_BYTES - 1))).toEqual(unknown);
    expect(await checkFreeSpace({ authoritative: false, freeBytes: () => Promise.resolve(1) })).toEqual(unknown);
    expect(await checkFreeSpace(advisory(MIN_FREE_BYTES))).toEqual({ ok: true, freeBytes: MIN_FREE_BYTES });
  });

  it('an unanswered, failing or nonsense measurement is unknown: recording is allowed with the fixed warning SPACE_UNKNOWN', async () => {
    const unknown = { ok: true, freeBytes: null, warning: 'SPACE_UNKNOWN' };
    expect(await checkFreeSpace(authoritative(null))).toEqual(unknown);
    expect(await checkFreeSpace({ authoritative: true, freeBytes: () => Promise.reject(new Error('/private/path denied')) })).toEqual(unknown);
    for (const odd of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(await checkFreeSpace(authoritative(odd))).toEqual(unknown);
    }
    expect(await checkFreeSpace(authoritative(2 * MIN_FREE_BYTES))).not.toHaveProperty('warning');
  });

  it('the storage-estimate port answers quota minus usage, is not authoritative (it measures the web view quota, not the files), and null when the platform gives no usable numbers', async () => {
    const port = createStorageEstimateDiskSpace({ estimate: () => Promise.resolve({ quota: 5000, usage: 1200 }) });
    expect(await port.freeBytes()).toBe(3800);
    expect(port.authoritative).not.toBe(true);
    expect(await createStorageEstimateDiskSpace({ estimate: () => Promise.resolve({ quota: 100, usage: 900 }) }).freeBytes()).toBe(0);
    expect(await createStorageEstimateDiskSpace({ estimate: () => Promise.resolve({}) }).freeBytes()).toBeNull();
    expect(await createStorageEstimateDiskSpace(undefined).freeBytes()).toBeNull();
    await expect(createStorageEstimateDiskSpace({ estimate: () => Promise.reject(new Error('no')) }).freeBytes()).rejects.toThrow();
  });

  it('through the estimate port a nearly full quota is advisory only, never LOW_SPACE', async () => {
    const full = createStorageEstimateDiskSpace({ estimate: () => Promise.resolve({ quota: 1000, usage: 999 }) });
    expect(await checkFreeSpace(full)).toEqual({ ok: true, freeBytes: null, warning: 'SPACE_UNKNOWN' });
    expect(createRealDiskSpace().authoritative).not.toBe(true);
  });
});

describe('createRealDiskSpace', () => {
  it('answers a number or null and never throws on a web view without the storage estimate', async () => {
    const free = await createRealDiskSpace().freeBytes();
    expect(free === null || (Number.isFinite(free) && free >= 0)).toBe(true);
  });
});

describe('resolveVideoUploadUrl: where a clip may be sent', () => {
  const R2_URL = `${ORIGIN}/api/public/uploads/video?token=vtoken0001.vsignature0001`;
  const UID = 'streamuid00000001';

  it('r2: accepts exactly the pinned origin, the video path and one well-formed token', () => {
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'r2' }, R2_URL)).toBe(R2_URL);
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'r2' }, '/api/public/uploads/video?token=vtoken0001.vsignature0001')).toBe(R2_URL);
  });

  const TOKEN = 'vtoken0001.vsignature0001';
  const REBUILT = `${ORIGIN}/api/public/uploads/video?token=${TOKEN}`;

  it.each([
    ['another host', `https://evil.test/api/public/uploads/video?token=${TOKEN}`],
    ['another scheme', `http://oi.example.test/api/public/uploads/video?token=${TOKEN}`],
    ['another port', `https://oi.example.test:8443/api/public/uploads/video?token=${TOKEN}`],
    ['a protocol-relative url', `//evil.test/api/public/uploads/video?token=${TOKEN}`],
    ['a relative path', `/api/public/uploads/video?token=${TOKEN}`],
    ['the engine host of a dev tunnel', `https://dev-tunnel.example.net/api/public/uploads/video?token=${TOKEN}`],
  ])('r2: %s is ignored: the transfer url is rebuilt on the pinned origin and never names the supplied host', (_name, url) => {
    const built = resolveVideoUploadUrl(ORIGIN, { provider: 'r2' }, url);
    expect(built).toBe(REBUILT);
    expect(built).not.toContain('evil.test');
    expect(built).not.toContain('dev-tunnel');
    expect(built).not.toContain('8443');
  });

  it.each([
    ['userinfo', `https://user:pw@oi.example.test/api/public/uploads/video?token=${TOKEN}`],
    ['userinfo naming another host', `https://oi.example.test@evil.test/api/public/uploads/video?token=${TOKEN}`],
    ['the photo path', `${ORIGIN}/api/public/uploads/photo?token=${TOKEN}`],
    ['a longer path', `${ORIGIN}/api/public/uploads/video/x?token=${TOKEN}`],
    ['a trailing slash', `${ORIGIN}/api/public/uploads/video/?token=${TOKEN}`],
    ['a dot segment', `${ORIGIN}/api/public/uploads/video/%2e?token=${TOKEN}`],
    ['a plain dot segment', `${ORIGIN}/api/public/uploads/video/.?token=${TOKEN}`],
    ['a parent segment that normalises back', `${ORIGIN}/api/public/uploads/x/../video?token=${TOKEN}`],
    ['a doubled slash', `${ORIGIN}//api/public/uploads/video?token=${TOKEN}`],
    ['a doubled slash inside', `${ORIGIN}/api//public/uploads/video?token=${TOKEN}`],
    ['an encoded slash', `${ORIGIN}/api%2fpublic/uploads/video?token=${TOKEN}`],
    ['an encoded slash in the last segment', `${ORIGIN}/api/public/uploads%2fvideo?token=${TOKEN}`],
    ['an encoded letter of the path', `${ORIGIN}/api/public/uploads/%76ideo?token=${TOKEN}`],
    ['no token', `${ORIGIN}/api/public/uploads/video`],
    ['an empty token', `${ORIGIN}/api/public/uploads/video?token=`],
    ['a short token', `${ORIGIN}/api/public/uploads/video?token=a.b`],
    ['a duplicate token', `${ORIGIN}/api/public/uploads/video?token=${TOKEN}&token=${TOKEN}`],
    ['an extra parameter', `${ORIGIN}/api/public/uploads/video?token=${TOKEN}&x=1`],
    ['a parameter that is not token', `${ORIGIN}/api/public/uploads/video?tok=${TOKEN}`],
    ['a token with a disallowed character', `${ORIGIN}/api/public/uploads/video?token=vtoken0001.vsig$nature01`],
    ['a token with an encoded space', `${ORIGIN}/api/public/uploads/video?token=vtoken0001.vsig%20nature01`],
    ['a malformed token', `${ORIGIN}/api/public/uploads/video?token=nodot`],
    ['a fragment', `${ORIGIN}/api/public/uploads/video?token=${TOKEN}#x`],
    ['whitespace', `${ORIGIN}/api/public/uploads/video?token=${TOKEN} `],
    ['a backslash', `${ORIGIN}\@evil.test/api/public/uploads/video?token=${TOKEN}`],
    ['a scheme that is not http', `ftp://oi.example.test/api/public/uploads/video?token=${TOKEN}`],
  ])('r2: refuses %s (the control above is accepted)', (_name, url) => {
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'r2' }, R2_URL)).toBe(R2_URL);
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'r2' }, url)).toBeNull();
  });

  it('r2: the photo upload url resolver still refuses a foreign host (the relaxation is for clips only)', () => {
    const photo = `/api/public/uploads/photo?token=${TOKEN}`;
    expect(resolveUploadUrl(ORIGIN, `${ORIGIN}${photo}`)).toBe(`${ORIGIN}${photo}`);
    expect(resolveUploadUrl(ORIGIN, `https://evil.test${photo}`)).toBeNull();
    expect(resolveUploadUrl(ORIGIN, `http://oi.example.test${photo}`)).toBeNull();
    expect(resolveUploadUrl(ORIGIN, `https://oi.example.test:8443${photo}`)).toBeNull();
  });

  it('stream: accepts exactly https on the documented upload host with the ref uid as the only path segment', () => {
    expect(STREAM_UPLOAD_HOST).toBe(STREAM_HOST);
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'stream', streamUid: UID }, `https://${STREAM_HOST}/${UID}`)).toBe(`https://${STREAM_HOST}/${UID}`);
  });

  it.each([
    ['http', `http://${STREAM_HOST}/${UID}`],
    ['another host', `https://upload.example.test/${UID}`],
    ['a look-alike suffix host', `https://${STREAM_HOST}.evil.test/${UID}`],
    ['a look-alike prefix host', `https://evil${STREAM_HOST}/${UID}`],
    ['a subdomain of the host', `https://a.${STREAM_HOST}/${UID}`],
    ['userinfo naming another host', `https://${STREAM_HOST}@evil.test/${UID}`],
    ['userinfo on the host', `https://u:p@${STREAM_HOST}/${UID}`],
    ['a port', `https://${STREAM_HOST}:8443/${UID}`],
    ['the pinned origin itself', `${ORIGIN}/${UID}`],
    ['the Stream customer host', `https://customer-abc.cloudflarestream.com/${UID}`],
    ['a different uid', `https://${STREAM_HOST}/otherouid00000001`],
    ['a sub-path', `https://${STREAM_HOST}/${UID}/x`],
    ['a query', `https://${STREAM_HOST}/${UID}?x=1`],
    ['a fragment', `https://${STREAM_HOST}/${UID}#x`],
    ['a backslash', `https://${STREAM_HOST}\\@evil.test/${UID}`],
    ['an empty string', ''],
  ])('stream: refuses %s (and the control above is accepted)', (_name, url) => {
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'stream', streamUid: UID }, `https://${STREAM_HOST}/${UID}`)).toBe(`https://${STREAM_HOST}/${UID}`);
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'stream', streamUid: UID }, url)).toBeNull();
  });

  it('refuses a non-string and an oversized value', () => {
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'r2' }, 42)).toBeNull();
    expect(resolveVideoUploadUrl(ORIGIN, { provider: 'r2' }, `${R2_URL}${'a'.repeat(5000)}`)).toBeNull();
  });
});

describe('video keys: the one stored string that says where a clip is', () => {
  const row = { pendingId: ID, inspectionId: INSPECTION, contentType: 'video/mp4' as const };

  it('r2 key: <tenant>/inspections/<this inspection>/videos/<media id>.<ext of the row>, nothing else', () => {
    expect(isExpectedVideoKey(R2_KEY, row)).toBe(true);
    expect(isExpectedVideoKey(`tenant-1/inspections/${INSPECTION}/videos/media-1.mov`, { ...row, contentType: 'video/quicktime' })).toBe(true);
    for (const bad of [
      `tenant-1/inspections/other/videos/media-1.mp4`,
      `tenant-1/inspections/${INSPECTION}/videos/media-1.mov`,
      `tenant-1/inspections/${INSPECTION}/photos/media-1.mp4`,
      `tenant-1/inspections/${INSPECTION}/videos/../media-1.mp4`,
      `tenant-1/inspections/${INSPECTION}/videos/media-1.poster.jpg`,
      `/tenant-1/inspections/${INSPECTION}/videos/media-1.mp4`,
      `tenant-1/inspections/${INSPECTION}/videos/media-1.mp4/x`,
      '',
      null,
      42,
    ]) {
      expect(isExpectedVideoKey(bad, row)).toBe(false);
    }
  });

  it('stream key: stream/<uid> only', () => {
    expect(isExpectedVideoKey('stream/streamuid00000001', row)).toBe(true);
    for (const bad of ['stream/', 'stream/a/b', 'stream/../x', 'streams/streamuid00000001', 'stream/a b']) expect(isExpectedVideoKey(bad, row)).toBe(false);
  });

  it('reads the reference back out of a key, for finalize and for the document step', () => {
    expect(videoRefFromKey(R2_KEY, INSPECTION)).toEqual({ provider: 'r2', mediaId: 'media-1', r2Key: R2_KEY });
    expect(videoRefFromKey('stream/streamuid00000001', INSPECTION)).toEqual({ provider: 'stream', streamUid: 'streamuid00000001' });
    expect(videoRefFromKey(`tenant-1/inspections/other/videos/media-1.mp4`, INSPECTION)).toBeNull();
    expect(videoRefFromKey('nonsense', INSPECTION)).toBeNull();
  });
});
