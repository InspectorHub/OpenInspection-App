import type { Files } from '../platform/files';
import { EXPORT_FILE_PATTERN } from './format';

/** At app start the share sheet of a killed run may still be reading its file, so only archives older than this are removed. */
export const APP_START_SWEEP_AGE_MS = 15 * 60_000;

export interface SweepResult {
  removed: number;
  failed: number;
}

/**
 * Removes export archives that an earlier run left in the cache directory (a crash, a kill, a share sheet that never returned).
 * Such a file holds customers' personal data in the clear, so it must not wait for the system to clear the cache.
 *
 * Only names this app wrote are touched: `inspectorhub-export-<milliseconds>.zip`. The age comes from the time in the name, so no
 * platform timestamp is needed; a name dated in the future (the clock moved back) counts as stale. Nothing else in the cache is
 * listed, read or removed. `minAgeMs` of zero removes every such file, which is right at the start of an export (one at a time is
 * enforced) and wrong at app start, where the share sheet of a killed run may still be reading the file.
 *
 * Never throws: a cache that cannot be listed removes nothing, and a file that cannot be removed is counted.
 */
export async function sweepStaleExports(files: Pick<Files, 'listCache' | 'removeCache'>, nowMs: number, minAgeMs: number): Promise<SweepResult> {
  const result: SweepResult = { removed: 0, failed: 0 };
  let entries: { name: string }[];
  try {
    entries = await files.listCache();
  } catch {
    return result;
  }
  for (const { name } of entries) {
    const match = EXPORT_FILE_PATTERN.exec(name);
    if (match === null) continue;
    const age = nowMs - Number(match[1]);
    if (age >= 0 && age < minAgeMs) continue;
    try {
      await files.removeCache(name);
      result.removed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
