import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { createHttp, type FetchLike } from '../auth/http';
import { refreshTokenKey } from '../auth/server-config';
import { createMemorySecureStore } from '../auth/test-support/memory-secure-store';
import { createTokenManager, type TokenManager } from '../auth/tokens';
import { enqueue } from '../offline/outbox';
import { ALICE, ORIGIN } from '../offline/test-support/replay-world';
import type { OfflineStack } from './offline-stack';
import { createStackWorld, type StackWorld } from './test-support/stack-world';

beforeEach(installStrictGlobals);
afterEach(restoreGlobals);

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };

type Mode = 'refuse' | 'revoked' | 'ok';

/** A real token manager (an expired access token, a stored refresh token) whose server is reached through `mode`. */
function realTokens(w: StackWorld, mode: { current: Mode }): TokenManager {
  const fetchLike: FetchLike = (_url, _init) => {
    if (mode.current === 'refuse') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode.current === 'revoked') return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } }));
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };
  return createTokenManager({
    http: createHttp({ fetch: fetchLike }),
    store: createMemorySecureStore({ [refreshTokenKey(ORIGIN)]: 'stored-refresh' }),
    clock: w.replay.clock,
    getClientId: () => Promise.resolve('client-1'),
    random: () => 1,
  });
}

type Status = ReturnType<OfflineStack['status']['get']>;

/** Resolves when the status satisfies `done`: by the stack's own signal, not by waiting. The refresher backs off on timers that only a test fires. */
function until(stack: OfflineStack, done: (status: Status) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (done(stack.status.get())) {
      resolve();
      return;
    }
    const off = stack.status.subscribe(() => {
      if (!done(stack.status.get())) return;
      off();
      resolve();
    });
  });
}

/** Starts the stack and waits for the first verdict it reaches about the server: a sign-in request or an unreachable server. */
async function startAndWaitForVerdict(stack: OfflineStack): Promise<void> {
  stack.start();
  await until(stack, (status) => status.auth || status.serverUnreachable);
}

async function stackWith(mode: { current: Mode }): Promise<{ w: StackWorld; stack: OfflineStack; key: string }> {
  const w = await createStackWorld();
  const tokens = realTokens(w, mode);
  const stack = w.make({ tokens });
  const row = await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
  return { w, stack, key: row.idempotencyKey };
}

describe('a server that cannot be reached while the network is up', () => {
  it('does not ask for a new sign-in (a refresh that never reached the server is not a refusal)', async () => {
    const { w, stack } = await stackWith({ current: 'refuse' });
    expect(await w.replay.network.online()).toBe(true);
    await startAndWaitForVerdict(stack);
    await stack.stop();
    expect(stack.status.get().auth).toBe(false);
  });

  it('says the server cannot be reached, and nothing was sent', async () => {
    const { w, stack } = await stackWith({ current: 'refuse' });
    await startAndWaitForVerdict(stack);
    await stack.stop();
    expect(stack.status.get().serverUnreachable).toBe(true);
    expect(w.pkg.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('control: the same stack, when the server is back, sends the work, shows no sign-in request and clears the unreachable state', async () => {
    const mode: { current: Mode } = { current: 'refuse' };
    const { w, stack, key } = await stackWith(mode);
    await startAndWaitForVerdict(stack);
    expect(stack.status.get().serverUnreachable).toBe(true);
    mode.current = 'ok';
    w.replay.clock.advance(10 * 60_000);
    await stack.replayer.idle();
    expect(await stack.replayer.retry(key)).toBe(true);
    await stack.replayer.idle();
    await stack.stop();
    expect(stack.status.get()).toMatchObject({ serverUnreachable: false, auth: false });
    expect(w.pkg.requests.some((r) => r.method === 'POST')).toBe(true);
  });
});

describe('a server that refuses the refresh', () => {
  it('control: a definite refusal (400 invalid_grant) still asks the person to sign in again, and is not "unreachable"', async () => {
    const { stack } = await stackWith({ current: 'revoked' });
    await startAndWaitForVerdict(stack);
    await stack.stop();
    expect(stack.status.get()).toMatchObject({ auth: true, serverUnreachable: false });
  });
});
