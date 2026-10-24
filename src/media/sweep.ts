import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';

/** A file without a row must be at least this old before it is removed, so a photo being stored right now is never touched. */
export const ORPHAN_MIN_AGE_MS = 60 * 60_000;

/**
 * A modification time below this cannot be a millisecond epoch instant (1e12 ms is September 2001). The unit the
 * iOS filesystem plugin reports is not verified: a value in seconds would make every file look decades old, so
 * such a value counts as unknown and the file is kept.
 */
export const MIN_PLAUSIBLE_MTIME_MS = 1e12;

const MEDIA_DIRECTORY = 'media';
/** The only names the store writes: `<pendingId>.<ext>`. Anything else in the directory is left alone. */
const MEDIA_FILE_PATTERN = /^([A-Za-z0-9_-]{1,64})\.(?:jpg|png|heic|mp4|mov)$/;

export interface SweepDeps {
  db: Db;
  files: Files;
  clock: Clock;
  /** Overrides `ORPHAN_MIN_AGE_MS`; tests only. */
  minAgeMs?: number;
}

export interface SweepResult {
  removed: number;
  /** Orphans that could not be removed; a later sweep tries again. */
  failed: number;
}

function isOld(mtimeMs: number | null | undefined, now: number, minAge: number): boolean {
  return typeof mtimeMs === 'number' && mtimeMs >= MIN_PLAUSIBLE_MTIME_MS && now - mtimeMs > minAge;
}

async function hasRow(db: Db, pendingId: string): Promise<boolean> {
  return (await db.query('SELECT 1 AS present FROM media WHERE pending_id = ?', [pendingId])).length > 0;
}

/**
 * Removes files in `media/` that no row refers to: what is left when the process dies between the file write
 * and the row insert of a new photo. A file is removed only when its name is one the store writes, no row has
 * that id (valid or not), and its modification time is known (a plausible millisecond instant) and older than the
 * minimum age. A file whose age the platform did not report, or reported implausibly, is kept. The row check and the
 * modification time are read again right before the removal, which closes the window a racing put would use.
 * Nothing is scheduled by this function; the caller decides when to sweep.
 */
export async function sweepOrphanFiles(deps: SweepDeps): Promise<SweepResult> {
  const minAge = deps.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const entries = await deps.files.list(MEDIA_DIRECTORY);
  const now = deps.clock.now();
  const result: SweepResult = { removed: 0, failed: 0 };
  for (const entry of entries) {
    const match = MEDIA_FILE_PATTERN.exec(entry.name);
    if (match === null || !isOld(entry.mtimeMs, now, minAge)) continue;
    const pendingId = match[1] ?? '';
    if (await hasRow(deps.db, pendingId)) continue;
    try {
      // Look again immediately before removing: a put that raced the first look has a row or a fresh file by now.
      if (await hasRow(deps.db, pendingId)) continue;
      const again = (await deps.files.list(MEDIA_DIRECTORY)).find((candidate) => candidate.name === entry.name);
      if (again === undefined || !isOld(again.mtimeMs, now, minAge)) continue;
      await deps.files.remove(`${MEDIA_DIRECTORY}/${entry.name}`);
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
