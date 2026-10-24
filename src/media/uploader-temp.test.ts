import { describe, expect, it } from 'vitest';
import { createMemoryFiles } from '../app/test-support/memory-files';
import { createManualClock } from '../platform/clock';
import { sweepUploaderTempFiles, UPLOADER_TEMP_MIN_AGE_MS } from './uploader-temp';

/** A plausible wall-clock instant in milliseconds; mtimes below 1e12 count as unknown. */
const NOW = 1_800_000_000_000;
const OLD = NOW - UPLOADER_TEMP_MIN_AGE_MS - 1;

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

    const result = await sweepUploaderTempFiles({ files, clock: createManualClock(NOW) });

    expect(result).toEqual({ removed: ['upload-1234567.tmp'], failed: [] });
    expect(files.cacheNames().sort()).toEqual(
      ['export.zip', 'upload-1111111.tmp', 'upload-12.tmp', 'upload-1234567.TMP', 'upload-1234567.tmp.bak', 'upload-2222222.tmp', 'upload-3333333.tmp', 'upload-7654321.tmp', 'upload-abc1234.tmp', 'xupload-1234567.tmp'].sort(),
    );
  });

  it('accepts 6 to 24 digits and nothing outside that', async () => {
    const files = createMemoryFiles();
    const names = [`upload-${'1'.repeat(5)}.tmp`, `upload-${'1'.repeat(6)}.tmp`, `upload-${'1'.repeat(24)}.tmp`, `upload-${'1'.repeat(25)}.tmp`];
    for (const name of names) files.seedCache(name, OLD);
    const result = await sweepUploaderTempFiles({ files, clock: createManualClock(NOW) });
    expect(result.removed.sort()).toEqual([names[1], names[2]].sort());
    expect(files.cacheNames().sort()).toEqual([names[0], names[3]].sort());
  });

  it('a removal that fails is reported, does not stop the others, and the file stays for a later sweep', async () => {
    const files = createMemoryFiles();
    files.seedCache('upload-1000000.tmp', OLD);
    files.seedCache('upload-2000000.tmp', OLD);
    files.failRemoveCacheFor('upload-1000000.tmp');
    const result = await sweepUploaderTempFiles({ files, clock: createManualClock(NOW) });
    expect(result.removed).toEqual(['upload-2000000.tmp']);
    expect(result.failed).toEqual([{ name: 'upload-1000000.tmp', reason: 'Unable to delete file' }]);
    expect(files.cacheNames()).toEqual(['upload-1000000.tmp']);
  });

  it('a listing that fails is reported and is not fatal', async () => {
    const files = createMemoryFiles();
    files.failListCache();
    expect(await sweepUploaderTempFiles({ files, clock: createManualClock(NOW) })).toEqual({
      removed: [],
      failed: [{ name: '(cache directory)', reason: 'Unable to list cache' }],
    });
  });

  it('control: an empty cache removes nothing', async () => {
    expect(await sweepUploaderTempFiles({ files: createMemoryFiles(), clock: createManualClock(NOW) })).toEqual({ removed: [], failed: [] });
  });
});
