import { errorWord, fail, fillerBytes, firstDifference, guarded, pass, type CheckDef, type DiagContext } from './types';
import { tinyJpegBytes } from '../jpeg';

const THREE_MIB = 3 * 1024 * 1024;
const FILE = 'media/diag-file.jpg';
const IMAGE = 'media/diag-image.jpg';
const MISSING = 'media/diag-missing.jpg';
const CACHE_FILE = 'diag-cache.bin';
const IMAGE_WAIT_MS = 5000;
const MIN_PLAUSIBLE_MTIME_MS = 1e12;
const MB = 1024 * 1024;

const def = { id: 'files', title: '[diag] files: Filesystem plugin write, stat, list, uri and cache' };

async function* chunks(): AsyncGenerator<Uint8Array> {
  yield new Uint8Array([1, 2, 3, 4]);
  yield new Uint8Array(1000).fill(7);
}

function sanitizeMessage(message: string): string {
  return message.replace(/media\/diag-[A-Za-z0-9._-]+/g, '<path>').replace(/[^\x20-\x7e]/g, '?').slice(0, 80);
}

async function removeQuietly(ctx: DiagContext, path: string): Promise<void> {
  const { files } = ctx.services;
  try {
    if (await files.exists(path)) await files.remove(path);
  } catch {
    // Cleanup is best effort; the next run starts by removing the same names.
  }
}

export const filesCheck: CheckDef = {
  ...def,
  hint: 'Writes a 3 MiB file under media/, checks size, listing, mtime unit, file uri, an image load through the display url, and the missing-file answer.',
  run: (ctx) =>
    guarded(def, async () => {
      const { files, clock } = ctx.services;
      const { ports } = ctx.deps;
      const started = clock.now();
      await removeQuietly(ctx, FILE);
      await removeQuietly(ctx, IMAGE);
      try {
        const data = fillerBytes(THREE_MIB, 0x1234abcd);
        const uri = await files.write(FILE, data);
        if (!(await files.exists(FILE))) return fail(def, 'exists=false after write');
        const size = await files.size(FILE);
        if (size !== THREE_MIB) return fail(def, `size=${String(size)} expected=${String(THREE_MIB)}`);
        const back = await files.read(FILE);
        if (back.length !== THREE_MIB || firstDifference(back, data) !== -1) return fail(def, `read_back=different len=${String(back.length)}`);

        const listed = await files.list('media');
        const entry = listed.find((item) => item.name === 'diag-file.jpg');
        if (!entry) return fail(def, 'list=missing_entry');
        const mtime = entry.mtimeMs;
        if (mtime === null) return fail(def, 'mtime=null');
        const digits = String(Math.trunc(Math.abs(mtime))).length;
        const plausible = mtime >= MIN_PLAUSIBLE_MTIME_MS;
        const uriOk = (await files.fileUri(FILE)).startsWith('file://');
        const writeUriOk = uri.startsWith('file://');

        await files.write(IMAGE, tinyJpegBytes());
        const shown = await files.displayUrl(IMAGE);
        const imageOk = await ports.loadImage(shown, IMAGE_WAIT_MS);

        const missingExists = await files.exists(MISSING);
        const raw = await ports.statMissing(MISSING);
        const rawText = raw === null ? 'stat_missing=succeeded' : `stat_missing_code=${raw.code ?? 'none'} stat_missing_msg="${sanitizeMessage(raw.message)}"`;

        await files.writeCacheChunks(CACHE_FILE, chunks());
        await files.removeCache(CACHE_FILE);

        const estimate = await ports.storageEstimate();
        const free = estimate !== null && estimate.quota !== null && estimate.usage !== null ? `${String(Math.max(0, Math.round((estimate.quota - estimate.usage) / MB)))}MB` : 'unknown';

        const summary = [
          `size=${String(size)}`,
          `mtime=${String(Math.trunc(mtime))}`,
          `mtime_digits=${String(digits)}`,
          `mtime_ge_1e12=${plausible ? 'yes' : 'no'}`,
          `file_uri=${uriOk && writeUriOk ? 'yes' : 'no'}`,
          `image_load=${imageOk ? 'yes' : 'no'}`,
          `missing_exists=${String(missingExists)}`,
          rawText,
          'cache=ok',
          `free_estimate=${free}`,
          `ms=${String(clock.now() - started)}`,
        ].join(' ');
        const good = plausible && uriOk && writeUriOk && imageOk && !missingExists;
        return good ? pass(def, summary) : fail(def, summary);
      } catch (error) {
        return fail(def, `threw ${errorWord(error)}`);
      } finally {
        await removeQuietly(ctx, FILE);
        await removeQuietly(ctx, IMAGE);
        await ctx.services.files.removeCache(CACHE_FILE).catch(() => undefined);
      }
    }),
};
