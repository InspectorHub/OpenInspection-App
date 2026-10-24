import { describe, expect, it } from 'vitest';
import { decideScreen } from '../app/boot';
import { connectToServer } from '../app/connect';
import { createSignedInWorld, createWorld, restartOffline, rowCounts, seedLocalData, type World } from '../app/test-support/world';
import { CLOCK_SKEW_TOLERANCE_MS, DAY_MS } from './lock';
import { evaluateAndPersist, loadLockState } from './lock-state';
import { verifyOnline } from './verify-online';

const SECURE = { allowInsecureHttp: false };
const START = 9_000_000;

function session(role: string, userId = 'user-1'): () => Response {
  return () => new Response(JSON.stringify({ success: true, data: { userId, tenantId: 'tenant-1', role, offlineMaxDays: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ success: false }), { status: 401, headers: { 'content-type': 'application/json' } });
}

async function lockedKey(world: World): Promise<string | null> {
  const rows = await world.db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'locked_reason'");
  return rows[0]?.value ?? null;
}

describe('verification is recorded by the auth layer', () => {
  it('a completed sign-in stores the verification time, the server limit and the latest time seen', async () => {
    const world = await createSignedInWorld();
    expect(await loadLockState(world.db)).toEqual({ lastVerifiedAt: START, maxSeenTime: START, offlineMaxDays: 30, revoked: false });
  });

  it('a successful refresh moves the verification time forward', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(2 * DAY_MS);
    expect((await world.services.tokens.refresh(world.server.origin, { ignoreBackoff: true })).kind).toBe('ok');
    const state = await loadLockState(world.db);
    expect(state.lastVerifiedAt).toBe(START + 2 * DAY_MS);
    expect(state.offlineMaxDays).toBe(30);
  });

  it('a session check stores the limit the server just reported', async () => {
    const world = await createSignedInWorld();
    await world.db.run("UPDATE device_state SET value = '7' WHERE key = 'offline_max_days'");
    world.clock.advance(1000);
    expect((await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true })).kind).toBe('ok');
    expect((await loadLockState(world.db)).offlineMaxDays).toBe(30);
  });

  it('control: a refresh that fails on the network changes nothing', async () => {
    const world = await createSignedInWorld();
    const offline = restartOffline(world);
    world.clock.advance(2 * DAY_MS);
    expect((await offline.services.tokens.refresh(world.server.origin, { ignoreBackoff: true })).kind).toBe('retry');
    expect((await loadLockState(world.db)).lastVerifiedAt).toBe(START);
  });
});

describe('revoked comes only from a definitive signal', () => {
  it('a refused refresh (invalid_grant) is NOT revoked: removed member, role change and password change look the same', async () => {
    const world = await createSignedInWorld();
    world.server.revokeAllGrants();
    expect((await world.services.tokens.refresh(world.server.origin, { ignoreBackoff: true })).kind).toBe('relogin');
    expect((await loadLockState(world.db)).revoked).toBe(false);
    expect(await lockedKey(world)).toBeNull();
    expect((await decideScreen(world.services, SECURE)).kind).toBe('sign_in');
  });

  it('the session endpoint answering 401 after a successful refresh is revoked, and boot then shows the locked screen', async () => {
    const world = await createSignedInWorld();
    world.server.queue('/api/client/session', unauthorized);
    world.server.queue('/api/client/session', unauthorized);
    expect((await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true })).kind).toBe('relogin');
    expect((await loadLockState(world.db)).revoked).toBe(true);
    const { services, calls } = restartOffline(world);
    expect(await decideScreen(services, SECURE)).toMatchObject({ kind: 'locked', reason: 'revoked' });
    expect(calls).toEqual([]);
  });

  it('control: a single 401 followed by a good answer is not revoked', async () => {
    const world = await createSignedInWorld();
    world.server.queue('/api/client/session', unauthorized);
    expect((await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true })).kind).toBe('ok');
    expect((await loadLockState(world.db)).revoked).toBe(false);
  });

  it('a role the app does not accept, for the person whose data is here, locks as revoked', async () => {
    const world = await createSignedInWorld();
    world.server.queue('/api/client/session', session('client'));
    await expect(world.services.flow.signIn(world.server.origin)).rejects.toMatchObject({ code: 'session_role_not_allowed' });
    expect((await loadLockState(world.db)).revoked).toBe(true);
  });

  it('control: the same refused role on a first sign-in with nothing stored locks nothing', async () => {
    const world = await createWorld();
    await connectToServer(world.services, world.server.origin);
    world.server.queue('/api/client/session', session('client'));
    await expect(world.services.flow.signIn(world.server.origin)).rejects.toMatchObject({ code: 'session_role_not_allowed' });
    expect(await lockedKey(world)).toBeNull();
  });

  it('control: a refused role for a different person than the stored one is an identity matter, not a revocation', async () => {
    const world = await createSignedInWorld();
    world.server.queue('/api/client/session', session('client', 'someone-else'));
    await expect(world.services.flow.signIn(world.server.origin)).rejects.toMatchObject({ code: 'session_role_not_allowed' });
    expect(await lockedKey(world)).toBeNull();
  });

  async function revokeViaSession(world: World): Promise<void> {
    world.server.queue('/api/client/session', unauthorized);
    world.server.queue('/api/client/session', unauthorized);
    expect((await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true })).kind).toBe('relogin');
    expect((await loadLockState(world.db)).revoked).toBe(true);
  }

  it('a refresh-only success does not clear a revocation, now or after a restart, and moves only the verification time', async () => {
    const world = await createSignedInWorld();
    await revokeViaSession(world);
    const before = await loadLockState(world.db);
    world.clock.advance(1000);
    expect((await world.services.tokens.refresh(world.server.origin, { ignoreBackoff: true })).kind).toBe('ok');
    expect((await world.services.tokens.getAccessToken(world.server.origin))?.length).toBeGreaterThan(0);
    const after = await loadLockState(world.db);
    expect(after.revoked).toBe(true);
    expect(after.lastVerifiedAt).toBe(START + 1000);
    expect(after.maxSeenTime).toBe(before.maxSeenTime);
    expect(await lockedKey(world)).toBe('revoked');
    expect(await decideScreen(restartOffline(world).services, SECURE)).toMatchObject({ kind: 'locked', reason: 'revoked' });
  });

  it('a refresh that succeeds and a session fetch that then fails on the network leaves the revocation in place', async () => {
    const world = await createSignedInWorld();
    await revokeViaSession(world);
    world.server.queue('/api/client/session', () => {
      throw new TypeError('network down');
    });
    expect((await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true })).kind).toBe('retry');
    expect((await loadLockState(world.db)).revoked).toBe(true);
    expect(await decideScreen(restartOffline(world).services, SECURE)).toMatchObject({ kind: 'locked', reason: 'revoked' });
  });

  it('control: a session-confirmed success clears the revocation', async () => {
    const world = await createSignedInWorld();
    await revokeViaSession(world);
    expect((await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true })).kind).toBe('ok');
    expect((await loadLockState(world.db)).revoked).toBe(false);
    expect((await decideScreen(restartOffline(world).services, SECURE)).kind).toBe('signed_in');
  });

  it('control: a sign-in for a different identity does not clear the revocation', async () => {
    const world = await createSignedInWorld();
    await revokeViaSession(world);
    world.server.queue('/api/client/session', session('inspector', 'someone-else'));
    await expect(world.services.flow.signIn(world.server.origin)).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect((await loadLockState(world.db)).revoked).toBe(true);
  });

  it('signing in successfully again clears a revocation', async () => {
    const world = await createSignedInWorld();
    world.server.queue('/api/client/session', session('client'));
    await world.services.flow.signIn(world.server.origin).catch(() => undefined);
    expect((await loadLockState(world.db)).revoked).toBe(true);
    await world.services.flow.signIn(world.server.origin);
    expect((await loadLockState(world.db)).revoked).toBe(false);
  });
});

describe('boot into a locked state makes no network call and deletes nothing', () => {
  it('past the offline period: locked as expired', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    world.clock.advance(31 * DAY_MS);
    const { services, calls } = restartOffline(world);
    expect(await decideScreen(services, SECURE)).toMatchObject({ kind: 'locked', reason: 'expired', identity: { role: 'inspector' } });
    expect(calls).toEqual([]);
    const after = await rowCounts(world.db);
    for (const table of ['ydoc_updates', 'media', 'outbox', 'resource_cache', 'work_package']) expect(after[table]).toBe(before[table]);
  });

  it('control: inside the period the same device opens signed in', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(29 * DAY_MS);
    expect((await decideScreen(restartOffline(world).services, SECURE)).kind).toBe('signed_in');
  });

  it('clock wound back after the app had seen a later time: locked as clock', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START);
    const { services, calls } = restartOffline(world);
    expect(await decideScreen(services, SECURE)).toMatchObject({ kind: 'locked', reason: 'clock' });
    expect(calls).toEqual([]);
  });

  it('the boot evaluation stores the latest time seen', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(5000);
    await decideScreen(restartOffline(world).services, SECURE);
    expect((await loadLockState(world.db)).maxSeenTime).toBe(START + 5000);
  });

  it('a device with no verification time (damaged record) opens locked, not signed in', async () => {
    const world = await createSignedInWorld();
    await world.db.run("DELETE FROM device_state WHERE key = 'last_verified_at'");
    expect(await decideScreen(restartOffline(world).services, SECURE)).toMatchObject({ kind: 'locked', reason: 'expired' });
  });
});

describe('verify online', () => {
  it('unlocks an expired device when the server accepts it', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: true, reason: 'expired' });
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'unlocked' });
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: false });
  });

  it('does NOT unlock a clock lock while the clock is still behind, and says so', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START);
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'locked', reason: 'clock' });
    expect((await loadLockState(world.db)).lastVerifiedAt).toBe(START);
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: true, reason: 'clock' });
  });

  it('control: once the clock is corrected, verifying unlocks the same device', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START + DAY_MS + 60_000);
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'unlocked' });
  });

  it('offline: a retry result, and the lock stays', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    const offline = restartOffline(world);
    expect(await verifyOnline(offline.services, world.server.origin)).toEqual({ kind: 'retry', cause: 'offline' });
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: true, reason: 'expired' });
  });

  it('a server fault is a retry with its own cause', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    world.server.queue('/oauth/token', () => new Response('{}', { status: 503 }));
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'retry', cause: 'server' });
  });

  it('a refused refresh sends the person to sign in again and does not lock as revoked', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    world.server.revokeAllGrants();
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'sign_in_required' });
    expect((await loadLockState(world.db)).revoked).toBe(false);
  });

  it('a session 401 after a good refresh answers revoked', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    world.server.queue('/api/client/session', unauthorized);
    world.server.queue('/api/client/session', unauthorized);
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'locked', reason: 'revoked' });
  });

  it('rows are untouched by any of it', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    world.clock.advance(31 * DAY_MS);
    await verifyOnline(world.services, world.server.origin);
    world.server.revokeAllGrants();
    await verifyOnline(world.services, world.server.origin);
    const after = await rowCounts(world.db);
    for (const table of ['ydoc_updates', 'media', 'outbox', 'resource_cache', 'work_package']) expect(after[table]).toBe(before[table]);
  });
});

describe('verify online re-anchors the clock reference only when the server vouches for the device clock', () => {
  const FORTY_DAYS = 40 * DAY_MS;

  /** A good session answer carrying the given `Date` header (null: no such header). */
  function sessionDated(date: string | null, userId = 'user-1'): () => Response {
    return () => {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (date !== null) headers.Date = date;
      return new Response(JSON.stringify({ success: true, data: { userId, tenantId: 'tenant-1', role: 'inspector', offlineMaxDays: 30 } }), { status: 200, headers });
    };
  }

  function httpDate(world: World, offsetMs = 0): string {
    return new Date(world.clock.now() + offsetMs).toUTCString();
  }

  /** The device clock jumped 40 days ahead and came back: locked as 'clock' for the whole gap. */
  async function jumpForwardAndBack(): Promise<World> {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    world.clock.advance(FORTY_DAYS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START);
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: true, reason: 'clock' });
    return world;
  }

  it('a server date matching the corrected clock unlocks, re-anchors, and leaves every local row alone', async () => {
    const world = await jumpForwardAndBack();
    const before = await rowCounts(world.db);
    world.server.queue('/api/client/session', sessionDated(httpDate(world)));
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'unlocked' });
    const state = await loadLockState(world.db);
    expect(state.maxSeenTime).toBe(START);
    expect(state.lastVerifiedAt).toBe(START);
    expect(await rowCounts(world.db)).toEqual(before);
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: false });
  });

  it.each([
    ['one hour ahead of the device', (w: World) => httpDate(w, 3_600_000)],
    ['one hour behind the device', (w: World) => httpDate(w, -3_600_000)],
    ['just beyond the tolerance', (w: World) => httpDate(w, CLOCK_SKEW_TOLERANCE_MS + 1000)],
    ['unparseable', () => 'not a date'],
    ['missing', () => null],
  ])('a server date that is %s does not re-anchor: the device stays locked as clock', async (_label, dateFor) => {
    const world = await jumpForwardAndBack();
    world.server.queue('/api/client/session', sessionDated(dateFor(world)));
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'locked', reason: 'clock' });
    expect((await loadLockState(world.db)).maxSeenTime).toBe(START + FORTY_DAYS);
  });

  it('a refresh-only success never re-anchors', async () => {
    const world = await jumpForwardAndBack();
    expect((await world.services.tokens.refresh(world.server.origin, { ignoreBackoff: true })).kind).toBe('ok');
    expect((await loadLockState(world.db)).maxSeenTime).toBe(START + FORTY_DAYS);
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: true, reason: 'clock' });
  });

  it('a device clock wrongly in the future and then corrected recovers without clearing local data', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(FORTY_DAYS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START + 60_000);
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: true, reason: 'clock' });
    world.server.queue('/api/client/session', sessionDated(httpDate(world)));
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'unlocked' });
    expect((await loadLockState(world.db)).maxSeenTime).toBe(START + 60_000);
  });

  it('a same-identity sign-in with a matching server date re-anchors too', async () => {
    const world = await jumpForwardAndBack();
    world.server.queue('/api/client/session', sessionDated(httpDate(world)));
    await world.services.flow.signIn(world.server.origin);
    expect((await loadLockState(world.db)).maxSeenTime).toBe(START);
    expect(await evaluateAndPersist(world.db, world.clock.now())).toEqual({ locked: false });
  });

  it('a revoked device re-anchors nothing until the session or a same-identity sign-in accepts it', async () => {
    const world = await jumpForwardAndBack();
    world.server.queue('/api/client/session', unauthorized);
    world.server.queue('/api/client/session', unauthorized);
    expect(await verifyOnline(world.services, world.server.origin)).toEqual({ kind: 'locked', reason: 'revoked' });
    expect((await loadLockState(world.db)).maxSeenTime).toBe(START + FORTY_DAYS);
    world.server.queue('/api/client/session', sessionDated(httpDate(world)));
    await world.services.flow.signIn(world.server.origin);
    const state = await loadLockState(world.db);
    expect(state.revoked).toBe(false);
    expect(state.maxSeenTime).toBe(START);
  });

  it('offline guard intact: with no network, rewinding the clock still locks as clock and nothing is re-anchored', async () => {
    const world = await jumpForwardAndBack();
    const offline = restartOffline(world);
    expect(await verifyOnline(offline.services, world.server.origin)).toEqual({ kind: 'retry', cause: 'offline' });
    expect(await decideScreen(offline.services, SECURE)).toMatchObject({ kind: 'locked', reason: 'clock' });
    expect((await loadLockState(world.db)).maxSeenTime).toBe(START + FORTY_DAYS);
  });
});
