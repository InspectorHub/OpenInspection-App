import { describe, expect, it, vi } from 'vitest';
import { AuthError } from '../auth/errors';
import { DesktopOpenError } from '../desktop/db-ipc';
import { refreshTokenKey } from '../auth/server-config';
import { SchemaDriftError, SchemaTooNewError } from '../platform/schema';
import { boot, decideScreen } from './boot';
import { connectToServer } from './connect';
import { createSignedInWorld as signedInWorld, createWorld, restartOffline } from './test-support/world';

const SECURE = { allowInsecureHttp: false };

describe('first screen', () => {
  it('no server remembered: server setup', async () => {
    const world = await createWorld();
    expect(await decideScreen(world.services, SECURE)).toEqual({ kind: 'setup' });
  });

  it('control: a remembered server leaves setup behind', async () => {
    const world = await createWorld();
    await connectToServer(world.services, world.server.origin);
    expect((await decideScreen(world.services, SECURE)).kind).not.toBe('setup');
  });

  it('server remembered, no token: sign in, without the relogin wording', async () => {
    const world = await createWorld();
    await connectToServer(world.services, world.server.origin);
    expect(await decideScreen(world.services, SECURE)).toEqual({ kind: 'sign_in', origin: world.server.origin, relogin: false, notices: [] });
  });

  it('stored token and no network: signed in, with no request made', async () => {
    const world = await signedInWorld();
    const { services, calls } = restartOffline(world);
    const screen = await decideScreen(services, SECURE);
    expect(screen).toEqual({
      kind: 'signed_in',
      origin: world.server.origin,
      identity: { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' },
    });
    expect(calls).toEqual([]);
  });

  it('a token for some other server does not count: sign in', async () => {
    const world = await signedInWorld();
    const token = world.store.entries()[refreshTokenKey(world.server.origin)];
    expect(token).toBeTruthy();
    await world.store.remove(refreshTokenKey(world.server.origin));
    await world.store.set(refreshTokenKey('https://other.example.test'), token ?? '');
    expect((await decideScreen(world.services, SECURE)).kind).toBe('sign_in');
  });

  it('a token but no stored identity: sign in rather than a signed-in screen with no one in it', async () => {
    const world = await signedInWorld();
    await world.db.run("DELETE FROM device_state WHERE key IN ('user_id', 'tenant_id', 'role')");
    expect((await decideScreen(restartOffline(world).services, SECURE)).kind).toBe('sign_in');
  });

  it('the server ended the session: sign in with the relogin wording', async () => {
    const world = await signedInWorld();
    world.server.revokeAllGrants();
    await world.services.tokens.refresh(world.server.origin, { ignoreBackoff: true });
    expect(await decideScreen(world.services, SECURE)).toEqual({ kind: 'sign_in', origin: world.server.origin, relogin: true, notices: [] });
  });

  it('a stored plain-http address to another host is not trusted in a release build', async () => {
    const world = await createWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('server_url', 'http://10.0.2.2:8787')");
    expect(await decideScreen(world.services, SECURE)).toEqual({ kind: 'setup' });
  });

  it('control: the same stored address is accepted when development builds allow it', async () => {
    const world = await createWorld();
    await world.db.run("INSERT INTO device_state (key, value) VALUES ('server_url', 'http://10.0.2.2:8787')");
    expect(await decideScreen(world.services, { allowInsecureHttp: true })).toMatchObject({ kind: 'sign_in', origin: 'http://10.0.2.2:8787' });
  });
});

describe('opening the app', () => {
  it('a database written by a newer app: the blocking screen, and no services', async () => {
    const result = await boot(() => Promise.reject(new SchemaTooNewError(9, 1)), SECURE);
    expect(result).toEqual({ services: null, screen: { kind: 'schema_too_new' } });
  });

  it('a database from before the in-place schema edit: its own blocking screen, not the newer-data one and not a crash', async () => {
    const result = await boot(() => Promise.reject(new SchemaDriftError('outbox.next_at')), SECURE);
    expect(result).toEqual({ services: null, screen: { kind: 'schema_drift' } });
  });

  it('control: an ordinary open reaches the decision', async () => {
    const world = await createWorld();
    const result = await boot(() => Promise.resolve(world.services), SECURE);
    expect(result.services).toBe(world.services);
    expect(result.screen).toEqual({ kind: 'setup' });
  });

  it('any other open failure is a distinct screen, not the newer-data one', async () => {
    const result = await boot(() => Promise.reject(new AuthError('storage_failed')), SECURE);
    expect(result).toEqual({ services: null, screen: { kind: 'open_failed' } });
  });

  it('keeps the typed desktop open reason for the recovery screen', async () => {
    const result = await boot(() => Promise.reject(new DesktopOpenError('key-unreadable')), SECURE);
    expect(result).toEqual({ services: null, screen: { kind: 'open_failed', reason: 'key-unreadable' } });
  });

  it('a failing first read closes the database it opened and shows the open-failed screen', async () => {
    const world = await createWorld();
    const close = vi.fn(() => Promise.resolve());
    const broken = { ...world.services, close, db: { ...world.db, query: () => Promise.reject(new Error('disk I/O error')) } };
    const result = await boot(() => Promise.resolve(broken), SECURE);
    expect(result).toEqual({ services: null, screen: { kind: 'open_failed' } });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('control: a successful boot leaves the database open', async () => {
    const world = await createWorld();
    const close = vi.fn(() => Promise.resolve());
    await boot(() => Promise.resolve({ ...world.services, close }), SECURE);
    expect(close).not.toHaveBeenCalled();
  });
});
