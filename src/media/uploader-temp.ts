import type { Clock } from '../platform/clock';
import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import { MAX_TRANSFER_MS } from './native-uploader';
import { MIN_PLAUSIBLE_MTIME_MS } from './sweep';

/**
 * The plugin writes a full copy of each multipart body into the app cache directory when an upload starts
 * and then only reads it, so a copy's modification time is when the transfer began. A clip transfer may run
 * for up to `MAX_TRANSFER_MS`; a file must be older than that ceiling plus one hour of margin before it is
 * removed, so the copy of a transfer that is still allowed to be running is never touched.
 */
export const UPLOADER_TEMP_MIN_AGE_MS = MAX_TRANSFER_MS + 60 * 60_000;

/** The only names the plugin writes: `upload-<digits>.tmp`. Anything else in the cache is left alone. */
const UPLOADER_TEMP_PATTERN = /^upload-[0-9]{6,24}\.tmp$/;

export interface UploaderTempSweepDeps {
  files: Files;
  clock: Clock;
  db: Db;
  /** True while the uploader has a transfer running. A check that cannot answer counts as true. */
  isUploading(): Promise<boolean>;
}

export interface UploaderTempSweepResult {
  /** Names of the files removed. */
  removed: string[];
  /** What could not be listed or removed, with a short reason; a later sweep tries again. */
  failed: { name: string; reason: string }[];
  /** Present when nothing was swept because an upload is, or may be, running. */
  skipped?: 'uploads_active';
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
}

async function uploadsMayBeRunning(deps: UploaderTempSweepDeps): Promise<boolean> {
  try {
    if (await deps.isUploading()) return true;
    const rows = await deps.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM media WHERE state = 'uploading'");
    return (rows[0]?.n ?? 1) > 0;
  } catch {
    return true;
  }
}

/**
 * Removes the plugin's leftover multipart body copies from the cache directory. Meant to run once at cold
 * start, before the uploader starts: it refuses to sweep at all (`skipped: 'uploads_active'`) when the
 * uploader reports a running transfer, when any media row is `uploading`, or when either check fails. A file
 * goes only when its name matches `upload-<6 to 24 digits>.tmp` exactly, its modification time is known (a
 * plausible millisecond instant) and it is older than `UPLOADER_TEMP_MIN_AGE_MS`. Every other file is kept,
 * including one whose age the platform did not report. Failures are collected, never thrown. Nothing
 * schedules this function.
 */
export async function sweepUploaderTempFiles(deps: UploaderTempSweepDeps): Promise<UploaderTempSweepResult> {
  const result: UploaderTempSweepResult = { removed: [], failed: [] };
  if (await uploadsMayBeRunning(deps)) return { ...result, skipped: 'uploads_active' };
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
