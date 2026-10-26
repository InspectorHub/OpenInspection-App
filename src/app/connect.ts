import { fetchCompat, writeDeviceState, type CompatInfo } from '../auth/server-config';
import type { AppServices } from './compose';

/**
 * Checks that `origin` is a compatible server, registers this app with it, and only then
 * remembers it. A server that fails either step is never stored, so the next launch does not
 * open on a sign-in page for a server that cannot sign anyone in.
 */
export async function connectToServer(services: AppServices, origin: string): Promise<CompatInfo> {
  const compat = await fetchCompat(services.http, origin, services.platform);
  await services.registrar.ensureClientId(origin);
  await writeDeviceState(services.db, 'server_url', origin);
  services.tokens.useOrigin(origin);
  return compat;
}
