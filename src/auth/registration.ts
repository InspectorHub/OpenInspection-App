import type { Db } from '../platform/db';
import { REDIRECT_URI } from './callback-constants';
import { AuthError } from './errors';
import type { Http } from './http';
import { clearClientId, loadClientId, saveClientId, serverEndpoints } from './server-config';

/** Shown on the consent page, where the engine appends the word "app" itself; keep it short and fixed. */
export const REGISTRATION_CLIENT_NAME = 'InspectorHub';
const MAX_CLIENT_ID_LENGTH = 256;

export interface RegistrationDeps {
  http: Http;
  db: Db;
}

export interface Registrar {
  /** The client id for this server: stored one if present, otherwise registers (RFC 7591) once. */
  ensureClientId(origin: string): Promise<string>;
  /** Drops the stored id, for the one re-registration allowed after `invalid_client`. */
  forget(origin: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the client id of a registration response, or null when the response is not acceptable. */
function validatedClientId(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const id = json.client_id;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_CLIENT_ID_LENGTH || !/^[\x21-\x7e]+$/.test(id)) return null;
  const uris = json.redirect_uris;
  if (uris !== undefined && !(Array.isArray(uris) && uris.length === 1 && uris[0] === REDIRECT_URI)) return null;
  if (json.token_endpoint_auth_method !== undefined && json.token_endpoint_auth_method !== 'none') return null;
  // A client_secret is deliberately never read: this is a public client.
  return id;
}

export function createRegistrar(deps: RegistrationDeps): Registrar {
  const inFlight = new Map<string, Promise<string>>();

  async function register(origin: string): Promise<string> {
    const res = await deps.http.request({
      url: serverEndpoints(origin).register,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: REGISTRATION_CLIENT_NAME,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    if (res.status === 404 || res.status === 501) throw new AuthError('native_login_unavailable');
    const clientId = res.status === 200 || res.status === 201 ? validatedClientId(res.json) : null;
    if (clientId === null) throw new AuthError('registration_failed');
    await saveClientId(deps.db, origin, clientId);
    return clientId;
  }

  return {
    ensureClientId: (origin) => {
      const running = inFlight.get(origin);
      if (running) return running;
      const started = (async () => (await loadClientId(deps.db, origin)) ?? (await register(origin)))();
      inFlight.set(origin, started);
      const clear = (): void => {
        inFlight.delete(origin);
      };
      started.then(clear, clear);
      return started;
    },
    forget: (origin) => clearClientId(deps.db, origin),
  };
}
