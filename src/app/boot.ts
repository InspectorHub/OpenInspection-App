import { loadIdentity, parseServerUrl, type StoredIdentity } from '../auth/server-config';
import { SchemaTooNewError } from '../platform/schema';
import type { CompatNotice } from './compat-notice';
import type { AppServices } from './compose';

export type Screen =
  | { kind: 'booting' }
  | { kind: 'setup' }
  | { kind: 'sign_in'; origin: string; relogin: boolean; notices: CompatNotice[] }
  | { kind: 'signed_in'; origin: string; identity: StoredIdentity }
  | { kind: 'schema_too_new' }
  | { kind: 'open_failed' };

export interface BootResult {
  services: AppServices | null;
  screen: Screen;
}

/**
 * Chooses the first screen from what is on the device. Nothing here touches the network: a
 * stored refresh token means "signed in", and whether the server still honours it is found out
 * later, so an inspector who opens the app in a basement is not sent to a sign-in page.
 */
export async function decideScreen(services: AppServices, options: { allowInsecureHttp: boolean }): Promise<Screen> {
  const rows = await services.db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'server_url'");
  const stored = rows[0]?.value;
  if (!stored) return { kind: 'setup' };
  let origin: string;
  try {
    origin = parseServerUrl(stored, { allowInsecureHttp: options.allowInsecureHttp });
  } catch {
    return { kind: 'setup' };
  }
  services.tokens.useOrigin(origin);
  const state = await services.tokens.getState(origin);
  if (state === 'relogin_required') return { kind: 'sign_in', origin, relogin: true, notices: [] };
  const identity = await loadIdentity(services.db);
  if (state === 'signed_in' && identity) return { kind: 'signed_in', origin, identity };
  return { kind: 'sign_in', origin, relogin: false, notices: [] };
}

/** Opens the app's services and decides the first screen; storage failures become screens, not crashes. */
export async function boot(open: () => Promise<AppServices>, options: { allowInsecureHttp: boolean }): Promise<BootResult> {
  let services: AppServices;
  try {
    services = await open();
  } catch (err) {
    return { services: null, screen: err instanceof SchemaTooNewError ? { kind: 'schema_too_new' } : { kind: 'open_failed' } };
  }
  try {
    return { services, screen: await decideScreen(services, options) };
  } catch {
    // The database is open but the first read failed: close it rather than leave the connection behind.
    await services.close().catch(() => undefined);
    return { services: null, screen: { kind: 'open_failed' } };
  }
}
