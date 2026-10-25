import type { DateFormat, SessionInfo, TimeFormat } from '@inspectorhub/field-ui';
import { accountKey, type Account } from '../offline/outbox';
import { readCached } from '../offline/resource-cache';
import type { Db } from '../platform/db';

/**
 * The editor's `SessionInfo`, built once from the cached `/api/session/context` and the signed-in account. The
 * fallback rules are the engine's `webSessionInfo`: viewer, else tenant, else the built-in default, decided per field.
 */

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const DATE_FORMATS: readonly string[] = ['us', 'iso', 'eu'];
const TIME_FORMATS: readonly string[] = ['12h', '24h'];
const dateFormat = (value: unknown): DateFormat | null => (typeof value === 'string' && DATE_FORMATS.includes(value) ? (value as DateFormat) : null);
const timeFormat = (value: unknown): TimeFormat | null => (typeof value === 'string' && TIME_FORMATS.includes(value) ? (value as TimeFormat) : null);

/** `data` of the session-context answer in, the snapshot out. Anything unusable is the fallback, never a throw. */
export function sessionInfoFrom(context: unknown): SessionInfo {
  const root = isRec(context) ? context : {};
  const user = isRec(root.user) ? root.user : null;
  const branding = isRec(root.branding) ? root.branding : null;
  // A context that does not carry both halves names no viewer (the web loader's rule).
  const viewer = user !== null && branding !== null ? user : null;
  const tenant = branding ?? {};

  return {
    tenantSlug: text(tenant.tenantSlug),
    videoProvider: root.videoProvider === 'stream' ? 'stream' : 'r2',
    streamCustomerSubdomain: null,
    // The offline model of the editor is the shared document; there is no form-save fallback to switch to.
    collabEditing: true,
    // Presence is off in this version: the socket url is built synchronously, and its ticket is a one-use credential.
    userId: null,
    role: viewer !== null && typeof viewer.role === 'string' ? viewer.role : '',
    locale: text(viewer?.locale) ?? (viewer !== null ? text(tenant.defaultLocale) : null) ?? 'en-US',
    timeZone: text(viewer?.timezone) ?? (viewer !== null ? text(tenant.defaultTimezone) : null) ?? 'UTC',
    dateFormat: dateFormat(viewer?.dateFormat) ?? dateFormat(tenant.dateFormat) ?? 'us',
    timeFormat: timeFormat(viewer?.timeFormat) ?? timeFormat(tenant.timeFormat) ?? '12h',
    tenantDateFormat: dateFormat(tenant.dateFormat) ?? 'us',
    tenantTimeFormat: timeFormat(tenant.timeFormat) ?? '12h',
  };
}

/** Reads this account's cached context. A missing or unreadable one gives the fallbacks. */
export async function loadSessionInfo(db: Db, account: Account): Promise<SessionInfo> {
  let data: unknown;
  try {
    const cached = await readCached(db, accountKey(account), '/api/session/context');
    const parsed: unknown = cached === null ? undefined : JSON.parse(cached.body);
    data = isRec(parsed) ? parsed.data : undefined;
  } catch {
    data = undefined;
  }
  return sessionInfoFrom(data);
}
