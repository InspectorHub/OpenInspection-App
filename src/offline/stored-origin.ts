import type { AppServices } from '../app/compose';

/** The server the stored identity last signed in to, or null when this device's data was saved before the app recorded it. */
export async function loadStoredOrigin(db: AppServices['db']): Promise<string | null> {
  const rows = await db.query<{ value: unknown }>("SELECT value FROM device_state WHERE key = 'identity_origin'");
  const value = rows[0]?.value;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
