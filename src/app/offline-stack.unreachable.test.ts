import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installStrictGlobals, restoreGlobals } from '../test-support/strict-globals';
import { AuthError } from '../auth/errors';
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

type Mode = 'refuse' | 'revoked' | 'ok' | 'forbidden' | 'rate_limited' | 'unavailable' | 'upgrade' | 'garbled';

const ANSWERS: Record<Exclude<Mode, 'refuse' | 'ok'>, { status: number; body: string }> = {
  revoked: { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) },
  forbidden: { status: 403, body: '{}' },
  rate_limited: { status: 429, body: '{}' },
  unavailable: { status: 503, body: '{}' },
  upgrade: { status: 426, body: '{}' },
  garbled: { status: 200, body: 'not json' },
};

interface Rig {
  w: StackWorld;
  stack: OfflineStack;
  tokens: TokenManager;
  mode: { current: Mode };
  key: string;
}

/** A real token manager (a stored refresh token, no cached access token) whose server is reached through `mode`. */
async function rig(initial: Mode, options: { brokenStore?: boolean } = {}): Promise<Rig> {
  const w = await createStackWorld();
  const mode: { current: Mode } = { current: initial };
  const fetchLike: FetchLike = () => {
    if (mode.current === 'refuse') return Promise.reject(new TypeError('Failed to fetch'));
    if (mode.current === 'ok') {
      return Promise.resolve(new Response(JSON.stringify({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'bearer', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }
    const answer = ANSWERS[mode.current];
    return Promise.resolve(new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } }));
  };
  const memory = createMemorySecureStore({ [refreshTokenKey(ORIGIN)]: 'stored-refresh' });
  const store = options.brokenStore === true ? { ...memory, get: () => Promise.reject(new Error('keystore unavailable')) } : memory;
  const tokens = createTokenManager({
    http: createHttp({ fetch: fetchLike }),
    store,
    clock: w.replay.clock,
    getClientId: () => Promise.resolve('client-1'),
    random: () => 1,
    onVerified: () => w.verified.fire(),
  });
  const stack = w.make({ tokens });
  const row = await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
  return { w, stack, tokens, mode, key: row.idempotencyKey };
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

const FLAGS = (status: Status) => ({ auth: status.auth, serverUnreachable: status.serverUnreachable, syncPaused: status.syncPaused });

/** Starts the stack and waits for the first verdict it reaches about the sync: a sign-in request, an unreachable server, or a pause. */
async function startAndSettle(stack: OfflineStack): Promise<Status> {
  stack.start();
  await until(stack, (status) => status.auth || status.serverUnreachable || status.syncPaused);
  await stack.stop();
  return stack.status.get();
}

describe('a server that cannot be reached while the network is up', () => {
  it('does not ask for a new sign-in (a refresh that never reached the server is not a refusal)', async () => {
    const { w, stack } = await rig('refuse');
    expect(await w.replay.network.online()).toBe(true);
    expect(FLAGS(await startAndSettle(stack))).toEqual({ auth: false, serverUnreachable: true, syncPaused: false });
  });

  it('nothing was sent', async () => {
    const { w, stack } = await rig('refuse');
    await startAndSettle(stack);
    expect(w.pkg.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('control: when the server is back, the work is sent and the unreachable state clears', async () => {
    const { w, stack, mode, key } = await rig('refuse');
    stack.start();
    await until(stack, (status) => status.serverUnreachable);
    mode.current = 'ok';
    w.replay.clock.advance(10 * 60_000);
    await stack.replayer.idle();
    expect(await stack.replayer.retry(key)).toBe(true);
    await stack.replayer.idle();
    await stack.stop();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: false, syncPaused: false });
    expect(w.pkg.requests.some((r) => r.method === 'POST')).toBe(true);
  });
});

describe('a server that answered, but not with a token', () => {
  it.each<[Mode]>([['forbidden'], ['rate_limited'], ['unavailable'], ['garbled']])('%s: sync is paused, the server is not called unreachable, and nobody is asked to sign in', async (mode) => {
    const { stack } = await rig(mode);
    expect(FLAGS(await startAndSettle(stack))).toEqual({ auth: false, serverUnreachable: false, syncPaused: true });
  });

  it('a device whose own storage fails: sync is paused, the server is never called unreachable', async () => {
    const { stack } = await rig('ok', { brokenStore: true });
    expect(FLAGS(await startAndSettle(stack))).toEqual({ auth: false, serverUnreachable: false, syncPaused: true });
  });

  it('a server that wants a newer app lights neither line (the update panel owns it) and asks for no sign-in', async () => {
    const { stack, w } = await rig('upgrade');
    stack.start();
    await stack.settled();
    await stack.replayer.idle();
    await stack.stop();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: false, syncPaused: false });
    expect(w.pkg.requests.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('a back-off keeps the cause that began it: a request held back by the wait is still "unreachable", not "paused"', async () => {
    const { stack, tokens } = await rig('refuse');
    stack.start();
    await until(stack, (status) => status.serverUnreachable);
    await expect(tokens.getAccessToken(ORIGIN)).rejects.toMatchObject({ retryCause: 'no_answer', code: 'server_unreachable' });
    await stack.stop();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: true, syncPaused: false });
  });

  it('the two grey states exclude each other: the later contact replaces the earlier', async () => {
    const { stack, mode, w, tokens } = await rig('refuse');
    stack.start();
    await until(stack, (status) => status.serverUnreachable);
    mode.current = 'forbidden';
    w.replay.clock.advance(60 * 60_000);
    await tokens.refresh(ORIGIN, { ignoreBackoff: true });
    await stack.replayer.retry((await stack.db.query<{ idempotency_key: string }>('SELECT idempotency_key FROM outbox'))[0]?.idempotency_key ?? '');
    await until(stack, (status) => status.syncPaused);
    await stack.stop();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: false, syncPaused: true });
  });
});

describe('a server that refuses the refresh', () => {
  it('control: a definite refusal (400 invalid_grant) still asks the person to sign in again, and is neither unreachable nor paused', async () => {
    const { stack } = await rig('revoked');
    expect(FLAGS(await startAndSettle(stack))).toEqual({ auth: true, serverUnreachable: false, syncPaused: false });
  });
});

describe('the grey lines clear on a real success, wherever it comes from', () => {
  it.each<[Mode]>([['refuse'], ['forbidden']])('after %s, a successful token refresh through the token manager (not through the stack\'s own http) clears them', async (mode) => {
    const { stack, tokens, w, mode: current } = await rig(mode);
    stack.start();
    await until(stack, (status) => status.serverUnreachable || status.syncPaused);
    current.current = 'ok';
    w.replay.clock.advance(60 * 60_000);
    expect((await tokens.refresh(ORIGIN, { ignoreBackoff: true })).kind).toBe('ok');
    await until(stack, (status) => !status.serverUnreachable && !status.syncPaused);
    await stack.stop();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: false, syncPaused: false });
  });

  it('control: a cache hit proves nothing, so it does not clear them', async () => {
    const { stack, tokens, w, mode } = await rig('refuse');
    stack.start();
    await until(stack, (status) => status.serverUnreachable);
    mode.current = 'ok';
    w.replay.clock.advance(60 * 60_000);
    await tokens.refresh(ORIGIN, { ignoreBackoff: true });
    await until(stack, (status) => !status.serverUnreachable);
    mode.current = 'refuse';
    w.replay.clock.advance(60 * 60_000);
    await expect(tokens.getAccessToken(ORIGIN)).rejects.toBeDefined();
    await until(stack, (status) => status.serverUnreachable);
    await stack.stop();
    expect(stack.status.get().serverUnreachable).toBe(true);
  });

  it('after a lock and an unlock a stale line does not show', async () => {
    const { stack, w } = await rig('refuse');
    stack.start();
    await until(stack, (status) => status.serverUnreachable);
    w.unlocks.note({ locked: true, reason: 'expired' });
    w.unlocks.note({ locked: false });
    await until(stack, (status) => !status.serverUnreachable && !status.syncPaused);
    await stack.stop();
    expect(FLAGS(stack.status.get())).toMatchObject({ serverUnreachable: false, syncPaused: false });
  });
});

describe('the grey lines and the two ways a server contact can clear them', () => {
  it('the later contact replaces the earlier in the other direction too: a pause gives way to "unreachable"', async () => {
    const { stack, mode, w, key } = await rig('forbidden');
    stack.start();
    await until(stack, (status) => status.syncPaused);
    mode.current = 'refuse';
    w.replay.clock.advance(60 * 60_000);
    await stack.replayer.idle();
    expect(await stack.replayer.retry(key)).toBe(true);
    await until(stack, (status) => status.serverUnreachable);
    await stack.stop();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: true, syncPaused: false });
  });

  it('a verified refresh clears them at once, before any request of the stack has had time to answer', async () => {
    const { stack, w } = await rig('refuse');
    stack.start();
    await until(stack, (status) => status.serverUnreachable);
    w.verified.fire();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: false, syncPaused: false });
    await stack.stop();
  });

  it('an answer from the stack own http clears "unreachable" when no token manager is involved', async () => {
    const w = await createStackWorld();
    const flaky = { down: true };
    const http = { request: (req: Parameters<typeof w.pkg.http.request>[0]) => (flaky.down ? Promise.reject(new AuthError('server_unreachable')) : w.pkg.http.request(req)) };
    const stack = w.make({ http });
    const row = await enqueue({ db: w.replay.db, clock: w.replay.clock }, 'inspection.create', CREATE, { account: ALICE });
    stack.start();
    await until(stack, (status) => status.serverUnreachable);
    flaky.down = false;
    w.replay.clock.advance(60 * 60_000);
    await stack.replayer.idle();
    expect(await stack.replayer.retry(row.idempotencyKey)).toBe(true);
    await until(stack, (status) => !status.serverUnreachable);
    await stack.stop();
    expect(FLAGS(stack.status.get())).toEqual({ auth: false, serverUnreachable: false, syncPaused: false });
  });
});
