import { describe, expect, it } from 'vitest';
import { connectToServer } from './connect';
import { createSignedInWorld } from './test-support/world';

describe('AppServices.onTokenVerified', () => {
  it('tells listeners after the verification was recorded, never before', async () => {
    const world = await createSignedInWorld();
    const seen: Promise<string | undefined>[] = [];
    world.services.onTokenVerified(() => {
      seen.push(world.db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'last_verified_at'").then((rows) => rows[0]?.value));
    });
    world.clock.advance(60_000);
    const check = await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true });
    expect(check.kind).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(await seen[0]).toBe(String(world.clock.now()));
  });

  it('stops telling a listener that unsubscribed, and a throwing listener changes nothing', async () => {
    const world = await createSignedInWorld();
    let calls = 0;
    const off = world.services.onTokenVerified(() => {
      calls += 1;
    });
    world.services.onTokenVerified(() => {
      throw new Error('boom');
    });
    off();
    world.clock.advance(60_000);
    const check = await world.services.tokens.checkSession(world.server.origin, { ignoreBackoff: true });
    expect(check.kind).toBe('ok');
    expect(calls).toBe(0);
    const rows = await world.db.query<{ value: string }>("SELECT value FROM device_state WHERE key = 'last_verified_at'");
    expect(rows[0]?.value).toBe(String(world.clock.now()));
  });

  it('is not told by the connection step, which verifies nothing', async () => {
    const world = await createSignedInWorld();
    let calls = 0;
    world.services.onTokenVerified(() => {
      calls += 1;
    });
    await connectToServer(world.services, world.server.origin);
    expect(calls).toBe(0);
  });
});
