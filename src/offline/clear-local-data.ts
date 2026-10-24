import type { Db } from '../platform/db';
import type { Files } from '../platform/files';
import { DEVICE_STATE_KEY_PREFIXES, type DeviceStateKey } from '../platform/schema';

/**
 * The `device_state` keys that survive a clear, so the person can sign in again to the same server
 * from the same installation:
 * - `server_url`: which server to sign in to.
 * - `device_id`: this installation's identity.
 * - `install_marker`: tells the first-launch check that this is not a fresh install; without it the
 *   next launch would treat the device as new and wipe the secure store.
 * - every `client_id:<origin>` registration: the OAuth client registered with that server.
 *
 * Everything else goes: who was signed in (`user_id`, `tenant_id`, `role`, `tenant_name`), the
 * verification and clock marks, the offline limit, `sync_days`, and `locked_reason` (so a revocation
 * ends with the data it protected).
 */
export const DEVICE_STATE_SURVIVORS = ['server_url', 'device_id', 'install_marker'] as const satisfies readonly DeviceStateKey[];
export const DEVICE_STATE_SURVIVOR_PREFIXES = DEVICE_STATE_KEY_PREFIXES;

export interface ClearResult {
  filesRemoved: number;
  /** Stored paths of media files that could not be removed (or were already missing). Their rows are gone either way. */
  filesFailed: string[];
}

/**
 * Permanently removes this device's local data: Yjs updates, media (rows and native files), the
 * write queue, the resource cache, the work package, and `device_state` except the survivors above.
 * The caller has already asked the person to confirm; nothing else in the app calls this.
 *
 * Files go first and each failure is recorded rather than thrown, so one stuck file cannot keep the
 * rest on the device. Then one statement per table, each atomic by itself, data tables first and
 * `device_state` last: a failure part-way leaves the lock marks in place and a second run finishes
 * the job (repeating is harmless).
 */
export async function clearLocalData(db: Db, files: Files): Promise<ClearResult> {
  const media = await db.query<{ path: string }>('SELECT path FROM media');
  let filesRemoved = 0;
  const filesFailed: string[] = [];
  for (const { path } of media) {
    try {
      await files.remove(path);
      filesRemoved += 1;
    } catch {
      filesFailed.push(path);
    }
  }

  for (const table of ['ydoc_updates', 'ydoc_sync', 'media', 'outbox', 'resource_cache', 'work_package', 'lease'] as const) {
    await db.run(`DELETE FROM ${table}`);
  }

  const keep = DEVICE_STATE_SURVIVORS.map(() => '?').join(', ');
  const prefixTests = DEVICE_STATE_SURVIVOR_PREFIXES.map(() => 'AND substr(key, 1, ?) <> ?').join(' ');
  const params: unknown[] = [...DEVICE_STATE_SURVIVORS];
  for (const prefix of DEVICE_STATE_SURVIVOR_PREFIXES) params.push(prefix.length, prefix);
  await db.run(`DELETE FROM device_state WHERE key NOT IN (${keep}) ${prefixTests}`, params);

  return { filesRemoved, filesFailed };
}
