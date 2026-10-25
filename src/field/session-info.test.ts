import { beforeEach, describe, expect, it } from 'vitest';
import { accountKey } from '../offline/outbox';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { GLOBAL_PACKAGE_ID } from '../offline/resource-cache';
import { loadSessionInfo, sessionInfoFrom } from './session-info';
import { ALICE, BOB, envelope } from './test-support/seed-package';

const CONTEXT = {
  user: { role: 'inspector', timezone: 'America/Chicago', locale: 'en-GB', dateFormat: 'iso', timeFormat: '24h', sessionMarker: 'marker-1' },
  branding: { tenantSlug: 'acme', defaultTimezone: 'America/New_York', defaultLocale: 'en-US', dateFormat: 'eu', timeFormat: '12h' },
  videoProvider: 'stream',
};

describe('session info from the session context', () => {
  it('resolves the viewer over the tenant, per field', () => {
    const info = sessionInfoFrom(CONTEXT);
    expect(info).toMatchObject({
      tenantSlug: 'acme',
      role: 'inspector',
      locale: 'en-GB',
      timeZone: 'America/Chicago',
      dateFormat: 'iso',
      timeFormat: '24h',
      tenantDateFormat: 'eu',
      tenantTimeFormat: '12h',
      videoProvider: 'stream',
    });
  });

  it('a user who set only the clock keeps the tenant date order', () => {
    const info = sessionInfoFrom({ ...CONTEXT, user: { role: 'owner', timeFormat: '24h' } });
    expect(info.dateFormat).toBe('eu');
    expect(info.timeFormat).toBe('24h');
    expect(info.locale).toBe('en-US');
    expect(info.timeZone).toBe('America/New_York');
  });

  it('an unrecognised stored value falls back instead of reaching the editor', () => {
    const info = sessionInfoFrom({ ...CONTEXT, user: { role: 'owner', dateFormat: 'martian', timeFormat: '99h' }, branding: { ...CONTEXT.branding, dateFormat: 'nope' } });
    expect(info.dateFormat).toBe('us');
    expect(info.timeFormat).toBe('12h');
    expect(info.tenantDateFormat).toBe('us');
  });

  it('without a usable context every answer is its fallback and role is empty, never a privilege', () => {
    for (const bad of [null, undefined, 'x', {}, { user: {} }, { branding: {} }]) {
      expect(sessionInfoFrom(bad)).toMatchObject({ tenantSlug: null, role: '', locale: 'en-US', timeZone: 'UTC', dateFormat: 'us', timeFormat: '12h', tenantDateFormat: 'us', tenantTimeFormat: '12h', videoProvider: 'r2' });
    }
  });

  it('presence is off, there is no stream subdomain, and collaborative editing is forced on', () => {
    for (const ctx of [CONTEXT, { ...CONTEXT, collabEditing: false }, null]) {
      const info = sessionInfoFrom(ctx);
      expect(info.userId).toBeNull();
      expect(info.streamCustomerSubdomain).toBeNull();
      expect(info.collabEditing).toBe(true);
    }
  });

  it('presence never takes an identity from the context, whatever it carries', () => {
    const info = sessionInfoFrom({ ...CONTEXT, userId: 'u-9', user: { ...CONTEXT.user, userId: 'u-1', id: 'u-2', sessionMarker: 'marker-7' } });
    expect(info.userId).toBeNull();
  });

  it('a viewer needs both halves of the context: without branding the user is no viewer, without user the tenant slug still reads', () => {
    const noBranding = sessionInfoFrom({ user: { role: 'owner', timezone: 'Asia/Tokyo', locale: 'ja-JP', dateFormat: 'iso', timeFormat: '24h' } });
    expect(noBranding).toMatchObject({ role: '', timeZone: 'UTC', locale: 'en-US', dateFormat: 'us', timeFormat: '12h' });
    const noUser = sessionInfoFrom({ branding: CONTEXT.branding });
    expect(noUser).toMatchObject({ tenantSlug: 'acme', role: '', timeZone: 'UTC', locale: 'en-US', dateFormat: 'eu', tenantDateFormat: 'eu' });
    const both = sessionInfoFrom({ user: { role: 'owner', timezone: 'Asia/Tokyo' }, branding: CONTEXT.branding });
    expect(both).toMatchObject({ role: 'owner', timeZone: 'Asia/Tokyo' });
  });

  it('an unknown video provider is the default one', () => {
    expect(sessionInfoFrom({ ...CONTEXT, videoProvider: 'vimeo' }).videoProvider).toBe('r2');
  });
});

describe('session info from the cache', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createSqlJsDb();
    await migrate(db, 0);
  });

  const put = (account: typeof ALICE, body: string) =>
    db.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, 1, ?)', [accountKey(account), '/api/session/context', body, GLOBAL_PACKAGE_ID]);

  it('reads this account cached context, not another account', async () => {
    await put(BOB, envelope({ ...CONTEXT, user: { ...CONTEXT.user, role: 'owner' } }));
    expect((await loadSessionInfo(db, ALICE)).role).toBe('');
    await put(ALICE, envelope(CONTEXT));
    expect((await loadSessionInfo(db, ALICE)).role).toBe('inspector');
  });

  it('a body that is not JSON gives the fallbacks', async () => {
    await put(ALICE, '{not json');
    expect(await loadSessionInfo(db, ALICE)).toMatchObject({ role: '', timeZone: 'UTC', collabEditing: true });
  });
});
