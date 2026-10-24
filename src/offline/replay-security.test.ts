import { afterEach, describe, expect, it, vi } from 'vitest';
import { OUTBOX_ERROR_CODES } from '../platform/schema';
import { listOutbox, readOutboxRow } from './outbox';
import { ALICE, BOB, createReplayWorld, deferred, GOOD_TOKEN, ORIGIN, unreachable, type ReplayWorld } from './test-support/replay-world';

const COMPLETE = (id: string) => ({ inspectionId: id });

function seed(w: ReplayWorld, ...ids: string[]): void {
  for (const id of ids) w.server.inspections.set(id, { cancelled: false });
}

async function snapshot(w: ReplayWorld): Promise<string> {
  return JSON.stringify(await w.db.query('SELECT * FROM outbox ORDER BY seq'));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a locked, revoked, expired or clock-locked device makes zero requests', () => {
  it('while locked: no request, the rows are untouched, the run says why (positive control: unlocked sends)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    const before = await snapshot(w);
    w.state.locked = true;
    const locked = await w.replayer.replay();
    expect(locked).toMatchObject({ sent: 0, halted: 'locked' });
    expect(w.server.requests).toHaveLength(0);
    expect(w.checkSession).not.toHaveBeenCalled();
    expect(await snapshot(w)).toBe(before);
    w.state.locked = false;
    expect((await w.replayer.replay()).sent).toBe(2);
    expect(w.server.requests).toHaveLength(2);
  });

  it('a lock state that cannot be read counts as locked', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.lockedThrows = true;
    expect((await w.replayer.replay()).halted).toBe('locked');
    expect(w.server.requests).toHaveLength(0);
    w.state.lockedThrows = false;
    expect((await w.replayer.replay()).sent).toBe(1);
  });

  it('the lock arriving in the middle of a run stops it before the next request (positive control: without it both are sent)', async () => {
    const control = await createReplayWorld();
    seed(control, 'a', 'b');
    await control.queue('inspection.complete', COMPLETE('a'));
    await control.queue('inspection.complete', COMPLETE('b'));
    await control.replayer.replay();
    expect(control.server.requests).toHaveLength(2);

    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    const second = await w.queue('inspection.complete', COMPLETE('b'));
    w.server.hook = () => {
      w.state.locked = true;
    };
    const result = await w.replayer.replay();
    expect(w.server.requests).toHaveLength(1);
    expect(result).toMatchObject({ sent: 1, halted: 'locked' });
    expect(await readOutboxRow(w.db, second.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('the lock arriving while the access token is being fetched stops the request before it is made', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    const reached = deferred();
    const release = deferred();
    w.state.tokenFn = async () => {
      reached.resolve();
      await release.promise;
      return GOOD_TOKEN;
    };
    const run = w.replayer.replay();
    await reached.promise;
    w.state.locked = true;
    release.resolve();
    const result = await run;
    expect(result.halted).toBe('locked');
    expect(w.server.requests).toHaveLength(0);
    expect(await readOutboxRow(w.db, row.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0, lastError: null });
  });

  it('a revoked device stays silent, and unlocking the device wakes a started replayer', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.locked = true;
    w.replayer.start();
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(0);
    w.state.locked = false;
    w.unlock();
    await w.replayer.idle();
    expect(w.server.requests).toHaveLength(1);
    expect(await w.rows()).toEqual([]);
    w.replayer.stop();
  });

  it('offline: no request (positive control: online sends)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.network.setQuietly(false);
    expect((await w.replayer.replay()).halted).toBe('offline');
    expect(w.server.requests).toHaveLength(0);
    w.network.setQuietly(true);
    expect((await w.replayer.replay()).sent).toBe(1);
  });

  it('going offline in the middle of a run stops it before the next request', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    w.server.hook = () => {
      w.network.setQuietly(false);
    };
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, halted: 'offline' });
    expect(w.server.requests).toHaveLength(1);
  });

  it('a 401 never deletes anything', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const before = await snapshot(w);
    w.state.token = 'stale';
    await w.replayer.replay();
    expect(await snapshot(w)).toBe(before);
  });
});

describe('P1-6: rows of another account are never sent and never touched', () => {
  it('replays only the signed-in account\'s rows (positive control: signed in as the other account sends theirs)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    const mine = await w.queue('inspection.complete', COMPLETE('a'), ALICE);
    const theirs = await w.queue('inspection.complete', COMPLETE('b'), BOB);
    const result = await w.replayer.replay();
    expect(result.sent).toBe(1);
    expect(w.server.requests.map((r) => r.url)).toEqual([`${ORIGIN}/api/inspections/a/complete`]);
    expect(await readOutboxRow(w.db, mine.idempotencyKey)).toBeNull();
    const kept = await readOutboxRow(w.db, theirs.idempotencyKey);
    expect(kept).toMatchObject({ state: 'pending', attempts: 0, lastError: null, nextAt: null, tenantId: 'tenant-1', userId: 'bob' });

    w.state.account = BOB;
    expect((await w.replayer.replay()).sent).toBe(1);
    expect(await w.rows()).toEqual([]);
  });

  it('the same user id in another tenant is another account', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'), { tenantId: 'tenant-2', userId: 'alice' });
    const before = await snapshot(w);
    await w.replayer.replay();
    expect(w.server.requests).toHaveLength(0);
    expect(await snapshot(w)).toBe(before);
  });

  it('a row without an owner (no tenant or user) is never sent', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    await w.db.run('UPDATE outbox SET tenant_id = NULL, user_id = NULL WHERE idempotency_key = ?', [row.idempotencyKey]);
    await w.replayer.replay();
    expect(w.server.requests).toHaveLength(0);
    expect(await readOutboxRow(w.db, row.idempotencyKey)).toMatchObject({ state: 'pending', tenantId: null });
  });

  it('nobody signed in: no request, nothing touched', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const before = await snapshot(w);
    w.state.account = null;
    expect((await w.replayer.replay()).halted).toBe('no_account');
    expect(w.server.requests).toHaveLength(0);
    expect(await snapshot(w)).toBe(before);
  });

  it('an account that cannot be read is nobody', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const replayer = w.another({
      account: () => {
        throw new Error('device_state unreadable');
      },
    });
    expect((await replayer.replay()).halted).toBe('no_account');
    expect(w.server.requests).toHaveLength(0);
  });

  it('the account changing while a request is in flight stops the run before the next row', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    const second = await w.queue('inspection.complete', COMPLETE('b'));
    w.server.hook = () => {
      w.state.account = BOB;
    };
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, halted: 'no_account' });
    expect(w.server.requests).toHaveLength(1);
    expect(await readOutboxRow(w.db, second.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('the url is built from the pinned origin and the registry route only', () => {
  it('every request goes to the pinned origin, under /api/inspections', async () => {
    const w = await createReplayWorld();
    await w.queue('inspection.create', { id: 'new-1', propertyAddress: '12 Test Street', templateId: 't' });
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    await w.replayer.replay();
    expect(w.server.requests.length).toBeGreaterThan(0);
    expect(w.stray()).toEqual([]);
    for (const request of w.server.requests) expect(new URL(request.url).origin).toBe(ORIGIN);
  });

  it('a row whose stored id is a path trick is failed and no request is made (positive control: a plain id is sent)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    for (const trick of ['../admin', 'a/../../x', 'a?x=1', '%2e%2e', 'a#b']) {
      await w.db.run('UPDATE outbox SET payload = ?, inspection_id = ?, state = ?, last_error = NULL WHERE idempotency_key = ?', [JSON.stringify({ inspectionId: trick }), trick, 'pending', row.idempotencyKey]);
      await w.replayer.replay();
      expect(await readOutboxRow(w.db, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'corrupt_payload' });
    }
    expect(w.server.requests).toHaveLength(0);
    await w.db.run('UPDATE outbox SET payload = ?, inspection_id = ?, state = ?, last_error = NULL WHERE idempotency_key = ?', [JSON.stringify({ inspectionId: 'a' }), 'a', 'pending', row.idempotencyKey]);
    await w.replayer.replay();
    expect(w.server.requests).toHaveLength(1);
  });

  it('text inside a payload never becomes part of a url', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.update', { inspectionId: 'a', changes: { propertyAddress: '/api/admin/../secrets?x=1' } });
    await w.replayer.replay();
    expect(w.server.requests.map((r) => r.url)).toEqual([`${ORIGIN}/api/inspections/a`]);
    expect(w.server.requests[0]?.body).toContain('/api/admin/../secrets?x=1');
  });
});

describe('nothing secret leaves through logs, errors or callbacks', () => {
  it('no console output, and no token, url or payload text in the error sink, halts or progress', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.update', { inspectionId: 'a', changes: { propertyAddress: 'PAYLOAD-MARKER street' } });
    const broken = w.another({
      onError: (error) => w.errors.push(error),
    });
    w.server.script.push(unreachable());
    await broken.replay();
    const original = w.db.transaction.bind(w.db);
    w.db.transaction = () => Promise.reject(new Error('disk I/O error'));
    w.clock.advance(3_600_000);
    await broken.replay();
    w.db.transaction = original;
    const sinks = JSON.stringify([w.errors.map((e) => String(e)), w.halts, w.progress, w.reconciles]);
    expect(sinks).not.toContain(GOOD_TOKEN);
    expect(sinks).not.toContain(ORIGIN);
    expect(sinks).not.toContain('PAYLOAD-MARKER');
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(w.errors.length).toBeGreaterThan(0);
  });

  it('the stored last_error is one of the fixed codes', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    w.server.script.push(unreachable());
    await w.replayer.replay();
    const rows = await listOutbox(w.db);
    expect(rows.map((r) => r.lastError)).toEqual(['network']);
    expect(OUTBOX_ERROR_CODES as readonly string[]).toContain(rows[0]?.lastError);
  });
});
