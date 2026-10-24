import { loadIdentity, parseServerUrl, type StoredIdentity } from '../auth/server-config';
import type { LockReason } from '../offline/lock';
import { evaluateAndPersist } from '../offline/lock-state';
import { SchemaDriftError, SchemaTooNewError } from '../platform/schema';
import type { CompatNotice } from './compat-notice';
import type { AppServices } from './compose';

export type Screen =
  | { kind: 'booting' }
  | { kind: 'setup' }
  | { kind: 'sign_in'; origin: string; relogin: boolean; notices: CompatNotice[]; /** Set when the person came from the lock screen: the identity that screen was holding, so Back can return to it. */ backToLock?: StoredIdentity }
  | { kind: 'signed_in'; origin: string; identity: StoredIdentity }
  /** Signed in, but the local data is held behind the lock screen. Nothing on it is deleted. */
  | { kind: 'locked'; origin: string; identity: StoredIdentity; reason: LockReason }
  | { kind: 'schema_too_new' }
  /** A development device still carries the first draft of the local database. */
  | { kind: 'schema_drift' }
  | { kind: 'open_failed' };

export interface BootResult {
  services: AppServices | null;
  screen: Screen;
}

/**
 * The screen for a device that is signed in: the work screens, or the lock screen when the offline
 * period, the clock or a revocation says the data must stay closed. Evaluates the lock (and stores
 * the latest time seen) without any network call.
 */
export async function screenForSignedIn(services: AppServices, origin: string, identity: StoredIdentity): Promise<Screen> {
  const outcome = await evaluateAndPersist(services.db, services.clock.now());
  return outcome.locked ? { kind: 'locked', origin, identity, reason: outcome.reason } : { kind: 'signed_in', origin, identity };
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
  if (state === 'signed_in' && identity) return screenForSignedIn(services, origin, identity);
  return { kind: 'sign_in', origin, relogin: false, notices: [] };
}

/** Opens the app's services and decides the first screen; storage failures become screens, not crashes. */
export async function boot(open: () => Promise<AppServices>, options: { allowInsecureHttp: boolean }): Promise<BootResult> {
  let services: AppServices;
  try {
    services = await open();
  } catch (err) {
    if (err instanceof SchemaTooNewError) return { services: null, screen: { kind: 'schema_too_new' } };
    if (err instanceof SchemaDriftError) return { services: null, screen: { kind: 'schema_drift' } };
    return { services: null, screen: { kind: 'open_failed' } };
  }
  try {
    return { services, screen: await decideScreen(services, options) };
  } catch {
    // The database is open but the first read failed: close it rather than leave the connection behind.
    await services.close().catch(() => undefined);
    return { services: null, screen: { kind: 'open_failed' } };
  }
}
