import { writeDeviceState } from '../auth/server-config';
import type { Db } from '../platform/db';

/**
 * How many days ahead the work package downloads. These are the choices the settings screen offers; the refresher itself reads the
 * stored value through `readSyncDays` and accepts 1 to 60, so a value written by an older build keeps working.
 */
export const SYNC_WINDOW_CHOICES = [7, 14, 30] as const;
export type SyncWindowChoice = (typeof SYNC_WINDOW_CHOICES)[number];

/** The offered choice a stored number stands for, or null when it is something else (the screen then shows no choice selected). */
export function syncWindowChoice(days: number): SyncWindowChoice | null {
  return SYNC_WINDOW_CHOICES.find((choice) => choice === days) ?? null;
}

/**
 * Stores the person's choice in `device_state.sync_days`, the row the work-package refresher reads at the start of every run.
 * Only writes the setting: nothing already on the device is touched, whatever the new window is. What leaves the device does so
 * through the reconcile rules and the person's own actions, never because a window got narrower.
 */
export async function writeSyncDays(db: Db, days: number): Promise<void> {
  if (syncWindowChoice(days) === null) throw new RangeError('The sync window must be 7, 14 or 30 days');
  await writeDeviceState(db, 'sync_days', String(days));
}
