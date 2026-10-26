import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { MAX_TRANSFER_MS } from './native-uploader';
import { sweepUploaderTempFiles, UPLOADER_TEMP_MIN_AGE_MS } from './uploader-temp';

/** A plausible wall-clock instant in milliseconds; mtimes below 1e12 count as unknown. */
const NOW = 1_800_000_000_000;
const OLD = NOW - UPLOADER_TEMP_MIN_AGE_MS - 1;
const HOUR_MS = 3_600_000;

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

/** Nothing uploading: no media row in that state and the uploader reports no active transfer. */
function idle(files: ReturnType<typeof createMemoryFiles>, overrides: { isUploading?: () => Promise<boolean> } = {}) {
  return { files, clock: createManualClock(NOW), db, isUploading: () => Promise.resolve(false), ...overrides };
}

async function insertMedia(state: string): Promise<void> {
  await db.run('INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [`m-${state}`, 'i1', 'video', '/v', 'video/mp4', '{}', state, 1]);
}

describe('sweepUploaderTempFiles: multipart body copies the upload plugin leaves in the cache directory', () => {
  it('removes an old match and keeps a recent one, a non-matching name, an unknown mtime and an implausible mtime', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1234567.tmp', OLD);
    files.seedCache('upload-7654321.tmp', NOW - UPLOADER_TEMP_MIN_AGE_MS + 1);
    files.seedCache('upload-1111111.tmp', NOW - UPLOADER_TEMP_MIN_AGE_MS);
    files.seedCache('upload-2222222.tmp', null);
    files.seedCache('upload-3333333.tmp', 5_000);
    files.seedCache('export.zip', OLD);
    files.seedCache('upload-12.tmp', OLD);
    files.seedCache('upload-abc1234.tmp', OLD);
    files.seedCache('upload-1234567.tmp.bak', OLD);
    files.seedCache('xupload-1234567.tmp', OLD);
    files.seedCache('upload-1234567.TMP', OLD);

    const result = await sweepUploaderTempFiles(idle(files));

    expect(result).toEqual({ removed: ['upload-1234567.tmp'], failed: [] });
    expect(files.cacheNames().sort()).toEqual(
      ['export.zip', 'upload-1111111.tmp', 'upload-12.tmp', 'upload-1234567.TMP', 'upload-1234567.tmp.bak', 'upload-2222222.tmp', 'upload-3333333.tmp', 'upload-7654321.tmp', 'upload-abc1234.tmp', 'xupload-1234567.tmp'].sort(),
    );
  });

  it('accepts 6 to 24 digits and nothing outside that', async () => {
    const files = createMemoryFiles();
    const names = [`upload-${'1'.repeat(5)}.tmp`, `upload-${'1'.repeat(6)}.tmp`, `upload-${'1'.repeat(24)}.tmp`, `upload-${'1'.repeat(25)}.tmp`];
    for (const name of names) files.seedCache(name, OLD);
    const result = await sweepUploaderTempFiles(idle(files));
    expect(result.removed.sort()).toEqual([names[1], names[2]].sort());
    expect(files.cacheNames().sort()).toEqual([names[0], names[3]].sort());
  });

  it('a removal that fails is reported, does not stop the others, and the file stays for a later sweep', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1000000.tmp', OLD);
    files.seedCache('upload-2000000.tmp', OLD);
    files.failRemoveCacheFor('upload-1000000.tmp');
    const result = await sweepUploaderTempFiles(idle(files));
    expect(result.removed).toEqual(['upload-2000000.tmp']);
    expect(result.failed).toEqual([{ name: 'upload-1000000.tmp', reason: 'Unable to delete file' }]);
    expect(files.cacheNames()).toEqual(['upload-1000000.tmp']);
  });

  it('a listing that fails is reported and is not fatal', async () => {
    const files = createMemoryFiles();
    files.failListCache();
    expect(await sweepUploaderTempFiles(idle(files))).toEqual({
      removed: [],
      failed: [{ name: '(cache directory)', reason: 'Unable to list cache' }],
    });
  });

  it('control: an empty cache removes nothing', async () => {
    expect(await sweepUploaderTempFiles(idle(createMemoryFiles()))).toEqual({ removed: [], failed: [] });
  });
});

describe('sweepUploaderTempFiles never takes the body of an upload that may still be running', () => {
  it('the age threshold is the longest possible clip transfer plus one hour', () => {
    expect(UPLOADER_TEMP_MIN_AGE_MS).toBe(MAX_TRANSFER_MS + HOUR_MS);
  });

  it('keeps a file written two hours ago while an upload is running, and removes nothing at all', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1234567.tmp', NOW - 2 * HOUR_MS);
    files.seedCache('upload-7654321.tmp', OLD);
    const result = await sweepUploaderTempFiles(idle(files, { isUploading: () => Promise.resolve(true) }));
    expect(result).toEqual({ removed: [], failed: [], skipped: 'uploads_active' });
    expect(files.cacheNames().sort()).toEqual(['upload-1234567.tmp', 'upload-7654321.tmp']);
  });

  it('refuses when a media row is uploading even though the uploader reports nothing', async () => {
    await insertMedia('uploading');
    const files = createMemoryFiles();
    files.seedCache('upload-1234567.tmp', OLD);
    expect(await sweepUploaderTempFiles(idle(files))).toEqual({ removed: [], failed: [], skipped: 'uploads_active' });
    expect(files.cacheNames()).toEqual(['upload-1234567.tmp']);
  });

  it.each(['pending', 'uploaded', 'failed'])('control: a media row that is only %s does not stop the sweep', async (state) => {
    await insertMedia(state);
    const files = createMemoryFiles();
    files.seedCache('upload-1234567.tmp', OLD);
    expect(await sweepUploaderTempFiles(idle(files))).toEqual({ removed: ['upload-1234567.tmp'], failed: [] });
  });

  it('control: nothing uploading and old enough removes the file', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1234567.tmp', NOW - UPLOADER_TEMP_MIN_AGE_MS - HOUR_MS);
    expect((await sweepUploaderTempFiles(idle(files))).removed).toEqual(['upload-1234567.tmp']);
  });

  it('with nothing uploading, a file two hours old is still kept: it is younger than the ceiling plus the margin', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1234567.tmp', NOW - 2 * HOUR_MS);
    expect(await sweepUploaderTempFiles(idle(files))).toEqual({ removed: [], failed: [] });
    expect(files.cacheNames()).toEqual(['upload-1234567.tmp']);
  });

  it('the boundary is the ceiling plus one hour: at it the file stays, one millisecond older it goes', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1000000.tmp', NOW - (MAX_TRANSFER_MS + HOUR_MS));
    files.seedCache('upload-2000000.tmp', NOW - (MAX_TRANSFER_MS + HOUR_MS) - 1);
    expect(await sweepUploaderTempFiles(idle(files))).toEqual({ removed: ['upload-2000000.tmp'], failed: [] });
    expect(files.cacheNames()).toEqual(['upload-1000000.tmp']);
  });

  it('an uploader check that throws is a refusal to sweep, not a licence to', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1234567.tmp', OLD);
    const result = await sweepUploaderTempFiles(idle(files, { isUploading: () => Promise.reject(new Error('uploader unavailable')) }));
    expect(result).toEqual({ removed: [], failed: [], skipped: 'uploads_active' });
    expect(files.cacheNames()).toEqual(['upload-1234567.tmp']);
  });
});
