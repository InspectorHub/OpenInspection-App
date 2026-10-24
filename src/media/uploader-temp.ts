import type { Clock } from '../platform/clock';
import type { Files } from '../platform/files';
import { MIN_PLAUSIBLE_MTIME_MS } from './sweep';

/**
 * The Android upload plugin writes a full copy of each multipart body into the app cache directory and
 * leaves it there when the upload is killed. A file must be at least this old before it is removed, so a
 * copy for an upload that is running right now is never touched.
 */
export const UPLOADER_TEMP_MIN_AGE_MS = 60 * 60_000;

/** The only names the plugin writes: `upload-<digits>.tmp`. Anything else in the cache is left alone. */
const UPLOADER_TEMP_PATTERN = /^upload-[0-9]{6,24}\.tmp$/;

export interface UploaderTempSweepDeps {
  files: Files;
  clock: Clock;
}

export interface UploaderTempSweepResult {
  /** Names of the files removed. */
  removed: string[];
  /** What could not be listed or removed, with a short reason; a later sweep tries again. */
  failed: { name: string; reason: string }[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
}

/**
 * Removes the plugin's leftover multipart body copies from the cache directory. A file goes only when its name
 * matches `upload-<6 to 24 digits>.tmp` exactly, its modification time is known (a plausible millisecond
 * instant) and it is older than `UPLOADER_TEMP_MIN_AGE_MS`. Every other file is kept, including one whose age
 * the platform did not report. Failures are collected, never thrown. Nothing schedules this function.
 */
export async function sweepUploaderTempFiles(deps: UploaderTempSweepDeps): Promise<UploaderTempSweepResult> {
  const result: UploaderTempSweepResult = { removed: [], failed: [] };
  let entries;
  try {
    entries = await deps.files.listCache();
  } catch (error) {
    result.failed.push({ name: '(cache directory)', reason: reasonOf(error) });
    return result;
  }
  const now = deps.clock.now();
  for (const entry of entries) {
    if (!UPLOADER_TEMP_PATTERN.test(entry.name)) continue;
    const mtime = entry.mtimeMs;
    if (mtime === null || mtime < MIN_PLAUSIBLE_MTIME_MS || now - mtime <= UPLOADER_TEMP_MIN_AGE_MS) continue;
    try {
      await deps.files.removeCache(entry.name);
      result.removed.push(entry.name);
    } catch (error) {
      result.failed.push({ name: entry.name, reason: reasonOf(error) });
    }
  }
  return result;
}
