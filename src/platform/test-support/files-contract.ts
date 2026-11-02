import { describe, expect, it } from 'vitest';
import type { Files } from '../files';

export function describeFilesContract(makeFiles: () => Files): void {
  describe('Files contract', () => {
    it('round-trips bytes and reports size, existence, and file URI', async () => {
      const files = makeFiles();
      const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 7]);
      await files.write('media/contract.jpg', bytes);
      expect(await files.read('media/contract.jpg')).toEqual(bytes);
      expect(await files.size('media/contract.jpg')).toBe(bytes.length);
      expect(await files.exists('media/contract.jpg')).toBe(true);
      expect(await files.fileUri('media/contract.jpg')).toMatch(/^file:\/\//);
    });
    it('returns false for a missing file and lists a missing directory as empty', async () => {
      const files = makeFiles();
      expect(await files.exists('media/no-such.jpg')).toBe(false);
      expect(await files.list('media/not-there')).toEqual([]);
    });
    it('lists entries with their stored casing and removes them', async () => {
      const files = makeFiles();
      await files.write('media/Contract/Case.JPG', Uint8Array.from([0xff, 0xd8, 0xff, 1]));
      expect((await files.list('media/Contract')).map((entry) => entry.name)).toEqual(['Case.JPG']);
      await files.remove('media/Contract/Case.JPG');
      expect(await files.exists('media/Contract/Case.JPG')).toBe(false);
    });
    it('does not touch an existing file when a stream fails before its first chunk', async () => {
      const files = makeFiles();
      const original = Uint8Array.from([0xff, 0xd8, 0xff, 1]);
      await files.write('media/contract-existing.jpg', original);
      async function* broken(): AsyncGenerator<Uint8Array> { throw new Error('failed before first chunk'); }
      await expect(files.writeStream('media/contract-existing.jpg', broken())).rejects.toThrow('failed before first chunk');
      expect(await files.read('media/contract-existing.jpg')).toEqual(original);
    });
    it('writes cache chunks and removes the cache file', async () => {
      const files = makeFiles();
      async function* chunks() { yield Uint8Array.from([1, 2]); yield Uint8Array.from([3]); }
      await files.writeCacheChunks('contract.bin', chunks());
      expect(await files.listCache()).toEqual([{ name: 'contract.bin', mtimeMs: expect.any(Number) }]);
      await files.removeCache('contract.bin');
      expect(await files.listCache()).toEqual([]);
    });
  });
}
