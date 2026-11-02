import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import { PHOTO_CACHE_DIRECTORY } from '../media/sweep';

/** The only names the photo cache writes: `photo-cache/<sha-256 in hex>.<ext>`. Nothing else is ever deleted through a row. */
const CACHE_FILE = new RegExp(`^${PHOTO_CACHE_DIRECTORY}/[0-9a-f]{64}\\.(?:jpg|png|webp)$`);

/** True for a path the photo cache itself wrote. */
export function isCacheFilePath(path: string): boolean {
  return CACHE_FILE.test(path);
}

/**
 * Removes the cached copies of server photos that belong to one account's inspection: the rows, then the files. A path
 * that is not a cache file name is never touched (the row alone goes). Best effort: the copies hold nothing that is not
 * on the server, so a failure here never blocks the purge or the cache; an eviction or a clear removes what stays.
 */
export async function purgePhotoCopies(db: Db, files: Pick<Files, 'remove'>, account: string, inspectionId: string): Promise<void> {
  try {
    const rows = await db.query<{ path: string }>('SELECT path FROM photo_cache WHERE account_key = ? AND inspection_id = ?', [account, inspectionId]);
    await db.run('DELETE FROM photo_cache WHERE account_key = ? AND inspection_id = ?', [account, inspectionId]);
    for (const { path } of rows) {
      if (!isCacheFilePath(path)) continue;
      await files.remove(path).catch(() => undefined);
    }
  } catch {
    // See above.
  }
}

const SWEEP_MIN_AGE_MS = 60_000;
const SWEEP_MAX_REMOVALS = 500;
/** The same floor `media/sweep.ts` uses: a smaller modification time is a platform that did not really report one. */
const MIN_PLAUSIBLE_MTIME_MS = 1e12;

/**
 * Removes cache files that no row of any account names (a crash between the file and its row, or between a purge's row
 * delete and its file delete). Bounded, best effort; a file younger than a minute (a store in flight) or of unknown age
 * stays. Answers how many went.
 */
export async function sweepPhotoCacheOrphans(db: Db, files: Pick<Files, 'list' | 'remove'>, nowMs: number, stopped: () => boolean, report: (error: unknown) => void): Promise<number> {
  let removed = 0;
  try {
    const named = new Set((await db.query<{ path: string }>('SELECT path FROM photo_cache')).map((r) => r.path));
    for (const entry of await files.list(PHOTO_CACHE_DIRECTORY)) {
      if (stopped() || removed >= SWEEP_MAX_REMOVALS) break;
      const path = `${PHOTO_CACHE_DIRECTORY}/${entry.name}`;
      if (!isCacheFilePath(path) || named.has(path) || entry.mtimeMs === null || entry.mtimeMs < MIN_PLAUSIBLE_MTIME_MS || nowMs - entry.mtimeMs < SWEEP_MIN_AGE_MS) continue;
      try {
        await files.remove(path);
        removed += 1;
      } catch (error) {
        report(error);
      }
    }
  } catch (error) {
    report(error);
  }
  return removed;
}
