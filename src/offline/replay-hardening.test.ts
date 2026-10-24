import { describe, expect, it, vi } from 'vitest';
import { acquireLease, DEFAULT_LEASE_TTL_MS, releaseLease, SYNC_LEASE } from './lease';
import { markWaiting, readOutboxRow } from './outbox';
import { MAX_RETRY_AFTER_MS, RESPONSE_MAX_BYTES } from './replay';
import { ALICE, BOB, createReplayWorld, failure, GOOD_TOKEN, ORIGIN, type ReplayWorld } from './test-support/replay-world';

const COMPLETE = (id: string) => ({ inspectionId: id });
const UPDATE = (id: string) => ({ inspectionId: id, changes: { sqft: 10 } });

function seed(w: ReplayWorld, ...ids: string[]): void {
  for (const id of ids) w.server.inspections.set(id, { cancelled: false });
}

async function stateOf(w: ReplayWorld, key: string) {
  const row = await readOutboxRow(w.db, key);
  return row === null ? null : { state: row.state, lastError: row.lastError, attempts: row.attempts, nextAt: row.nextAt };
}

describe('M1: the account is checked again after the token, right before the request', () => {
  it('an account switch while the token is fetched makes no request at all (positive control: no switch is sent)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.state.tokenFn = () => {
      w.state.account = BOB;
      return Promise.resolve('bob-token');
    };
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 0, halted: 'no_account' });
    expect(w.server.requests).toHaveLength(0);
    expect(await stateOf(w, row.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });

    const control = await createReplayWorld();
    seed(control, 'a');
    await control.queue('inspection.complete', COMPLETE('a'));
    control.state.tokenFn = () => Promise.resolve(GOOD_TOKEN);
    expect(await control.replayer.replay()).toMatchObject({ sent: 1, halted: null });
    expect(control.server.requests).toHaveLength(1);
  });

  it('signing out while the token is fetched makes no request either', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.tokenFn = () => {
      w.state.account = null;
      return Promise.resolve(GOOD_TOKEN);
    };
    expect(await w.replayer.replay()).toMatchObject({ sent: 0, halted: 'no_account' });
    expect(w.server.requests).toHaveLength(0);
  });

  it('a switch to another tenant with the same user id is also refused', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.tokenFn = () => {
      w.state.account = { tenantId: 'tenant-2', userId: ALICE.userId };
      return Promise.resolve('other-tenant-token');
    };
    expect(await w.replayer.replay()).toMatchObject({ sent: 0, halted: 'no_account' });
    expect(w.server.requests).toHaveLength(0);
  });
});

describe('M-3: the lease is renewed after the token as well', () => {
  it('a lease taken over while the token is fetched stops the run before the request (positive control: a held lease sends)', async () => {
    const w = await createReplayWorld({ leaseTtlMs: 10_000 });
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.state.tokenFn = async () => {
      w.clock.advance(11_000);
      await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, ttlMs: 10_000, newToken: () => 'thief' });
      return GOOD_TOKEN;
    };
    expect(await w.replayer.replay()).toMatchObject({ sent: 0, halted: 'lease_lost' });
    expect(w.server.requests).toHaveLength(0);
    expect(await stateOf(w, row.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });

    const control = await createReplayWorld({ leaseTtlMs: 10_000 });
    seed(control, 'a');
    await control.queue('inspection.complete', COMPLETE('a'));
    expect((await control.replayer.replay()).sent).toBe(1);
  });

  it('the request goes out under a lease that was extended after the slow token, not before it', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.tokenFn = () => {
      w.clock.advance(30_000);
      return Promise.resolve(GOOD_TOKEN);
    };
    let expiresAtDuringRequest = 0;
    w.server.hook = async () => {
      const rows = await w.db.query<{ expires_at: number }>('SELECT expires_at FROM lease WHERE name = ?', [SYNC_LEASE]);
      expiresAtDuringRequest = rows[0]?.expires_at ?? 0;
    };
    await w.replayer.replay();
    expect(expiresAtDuringRequest).toBe(w.clock.now() + DEFAULT_LEASE_TTL_MS);
  });
});

describe('I1: a busy lease is asked again after seconds, not minutes', () => {
  it('arms a 2 to 5 second timer with jitter, never below the one second floor', async () => {
    const delays: number[] = [];
    for (const random of [0, 0.5, 0.999]) {
      const w = await createReplayWorld({ fallbackIntervalMs: 600_000 });
      seed(w, 'a');
      await w.queue('inspection.complete', COMPLETE('a'));
      await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, newToken: () => 'other-flow' });
      const replayer = w.another({ random: () => random });
      replayer.start();
      await replayer.idle();
      delays.push(...w.timers.delays());
      replayer.stop();
    }
    expect(delays).toEqual([2000, 3500, 4997]);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(5000);
    }
  });

  it('a lease that frees up is picked up by the next short retry', async () => {
    const w = await createReplayWorld({ fallbackIntervalMs: 600_000 });
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, newToken: () => 'other-flow' });
    w.replayer.start();
    await w.replayer.idle();
    expect(w.timers.delays()).toEqual([3500]);
    await releaseLease(w.db, SYNC_LEASE, 'other-flow');
    w.timers.fireNext();
    await w.replayer.idle();
    expect(await w.rows()).toEqual([]);
    w.replayer.stop();
  });

  it('is bounded: ten short retries in a row, then the slow fallback (no tight loop); a free lease resets the count', async () => {
    const w = await createReplayWorld({ fallbackIntervalMs: 600_000 });
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, ttlMs: 3_000_000, newToken: () => 'other-flow' });
    w.replayer.start();
    await w.replayer.idle();
    const seen: number[] = [...w.timers.delays()];
    for (let i = 0; i < 11; i += 1) {
      w.timers.fireNext();
      await w.replayer.idle();
      seen.push(...w.timers.delays());
    }
    expect(seen.slice(0, 10)).toEqual(Array<number>(10).fill(3500));
    expect(seen.slice(10)).toEqual(Array<number>(2).fill(600_000));

    await releaseLease(w.db, SYNC_LEASE, 'other-flow');
    w.timers.fireNext();
    await w.replayer.idle();
    expect(await w.rows()).toEqual([]);
    seed(w, 'b');
    await w.queue('inspection.complete', COMPLETE('b'));
    await acquireLease(w.db, SYNC_LEASE, { clock: w.clock, ttlMs: 3_000_000, newToken: () => 'other-flow' });
    w.network.set(true);
    await w.replayer.idle();
    expect(w.timers.delays()).toEqual([3500]);
    w.replayer.stop();
  });

  it('a halt for another reason keeps the slow fallback (positive control for the busy-only rule)', async () => {
    const w = await createReplayWorld({ fallbackIntervalMs: 10_000 });
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.locked = true;
    w.replayer.start();
    await w.replayer.idle();
    expect(w.timers.delays()).toEqual([10_000]);
    w.replayer.stop();
  });
});

describe('I2: only sendable heads are paged, so stuck heads cannot starve healthy lines', () => {
  it('250 failed heads in front of 10 healthy pending lines: all 10 are sent', async () => {
    const w = await createReplayWorld();
    for (let i = 0; i < 260; i += 1) {
      const id = `insp-${String(i)}`;
      seed(w, id);
      await w.queue('inspection.complete', COMPLETE(id));
    }
    await w.db.run("UPDATE outbox SET state = 'failed', last_error = 'validation_failed' WHERE seq <= 250");
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 10, failed: 0, halted: null });
    expect(w.server.requests).toHaveLength(10);
    expect(await w.db.query("SELECT COUNT(*) AS n FROM outbox WHERE state = 'failed'")).toEqual([{ n: 250 }]);
  });

  it('250 waiting and orphaned heads do not starve healthy lines either, and the earliest wake is still armed', async () => {
    const w = await createReplayWorld();
    for (let i = 0; i < 260; i += 1) {
      const id = `insp-${String(i)}`;
      seed(w, id);
      await w.queue('inspection.complete', COMPLETE(id));
    }
    await w.db.run("UPDATE outbox SET state = 'orphaned', last_error = 'target_gone' WHERE seq <= 125");
    await w.db.run(`UPDATE outbox SET last_error = 'network', next_at = ${String(w.clock.now() + 9000)} WHERE seq > 125 AND seq <= 250`);
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 10, halted: null });
    expect(w.timers.delays()).toEqual([9000]);
  });

  it('more than one page of healthy lines: all are sent in one run', async () => {
    const w = await createReplayWorld();
    for (let i = 0; i < 450; i += 1) {
      const id = `insp-${String(i)}`;
      seed(w, id);
      await w.queue('inspection.complete', COMPLETE(id));
    }
    const result = await w.replayer.replay();
    expect(result.sent).toBe(450);
    expect(await w.rows()).toEqual([]);
  });

  it('ordering is kept: a later write of a failed, waiting or orphaned head is never sent (positive control: another line is)', async () => {
    const w = await createReplayWorld();
    seed(w, 'failed', 'waiting', 'orphaned', 'free');
    const heads = {
      failed: await w.queue('inspection.update', UPDATE('failed')),
      waiting: await w.queue('inspection.update', UPDATE('waiting')),
      orphaned: await w.queue('inspection.update', UPDATE('orphaned')),
    };
    const laters = [await w.queue('inspection.complete', COMPLETE('failed')), await w.queue('inspection.complete', COMPLETE('waiting')), await w.queue('inspection.complete', COMPLETE('orphaned'))];
    await w.queue('inspection.complete', COMPLETE('free'));
    await w.db.run("UPDATE outbox SET state = 'failed', last_error = 'validation_failed' WHERE idempotency_key = ?", [heads.failed.idempotencyKey]);
    await w.db.run("UPDATE outbox SET state = 'orphaned', last_error = 'target_gone' WHERE idempotency_key = ?", [heads.orphaned.idempotencyKey]);
    await markWaiting(w.db, heads.waiting.idempotencyKey, 'network', w.clock.now() + 60_000);
    const result = await w.replayer.replay();
    expect(result.sent).toBe(1);
    expect(w.server.requests.map((r) => r.url)).toEqual([`${ORIGIN}/api/inspections/free/complete`]);
    for (const later of laters) expect(await stateOf(w, later.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });
  });
});

describe('I3: the stored payload is validated again at replay', () => {
  it('unknown keys, a tenant id and a __proto__ key never reach the request body', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.update', UPDATE('a'));
    const stored = '{"inspectionId":"a","tenantId":"evil","changes":{"sqft":10,"tenantId":"evil","__proto__":{"admin":true},"status":"cancelled"},"__proto__":{"polluted":true}}';
    await w.db.run('UPDATE outbox SET payload = ? WHERE idempotency_key = ?', [stored, row.idempotencyKey]);
    await w.replayer.replay();
    expect(w.server.requests).toHaveLength(1);
    const body = w.server.requests[0]?.body ?? '';
    expect(JSON.parse(body)).toEqual({ sqft: 10 });
    expect(body).not.toContain('tenantId');
    expect(body).not.toContain('__proto__');
    expect(body).not.toContain('status');
  });

  it('a stored payload that no longer parses becomes failed corrupt_payload and nothing is sent', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.update', UPDATE('a'));
    await w.db.run('UPDATE outbox SET payload = ? WHERE idempotency_key = ?', ['{"inspectionId":"a","changes":{"sqft":-5}}', row.idempotencyKey]);
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(w.server.requests).toHaveLength(0);
    expect(await stateOf(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'corrupt_payload' });
  });
});

describe('M-2: a 403 that is a known refusal is not a vanished target', () => {
  it.each(['tenant_suspended', 'TENANT_SUSPENDED', 'FINANCIAL_REQUIRED', 'CAPABILITY_CEILING', 'ROLE_CEILING', 'SELF_PERMISSION_CHANGE'])('403 %s is rejected, visibly, and no reconcile is asked for', async (code) => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(403, code));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ failed: 1, waiting: 0 });
    expect(await stateOf(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'rejected' });
    expect(w.reconciles).toEqual([]);
  });

  it.each(['forbidden', 'FORBIDDEN', 'not_found'])('positive control: a plain 403/404 %s (the inspector is not on the roster) still waits for a check', async (code) => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(code === 'not_found' ? 404 : 403, code));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ failed: 0, waiting: 1 });
    expect(await stateOf(w, row.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'target_not_visible' });
    expect(w.reconciles).toEqual(['a']);
  });

  it('a 403 with no code at all is a plain 403', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push({ ...failure(403, 'X'), json: { success: false }, text: '' });
    await w.replayer.replay();
    expect(await stateOf(w, row.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'target_not_visible' });
  });
});

describe('M-5: survivors of the mutation run', () => {
  it('P14: a next_at far beyond any wait this module writes (clock set back) is due; one at the edge waits', async () => {
    const edge = 2 * MAX_RETRY_AFTER_MS;
    const w = await createReplayWorld();
    seed(w, 'far', 'edge');
    const far = await w.queue('inspection.complete', COMPLETE('far'));
    const atEdge = await w.queue('inspection.complete', COMPLETE('edge'));
    await markWaiting(w.db, far.idempotencyKey, 'network', w.clock.now() + edge + 1);
    await markWaiting(w.db, atEdge.idempotencyKey, 'network', w.clock.now() + edge);
    const result = await w.replayer.replay();
    expect(result.sent).toBe(1);
    expect(w.server.requests.map((r) => r.url)).toEqual([`${ORIGIN}/api/inspections/far/complete`]);
    expect(await stateOf(w, atEdge.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 1 });
  });

  it('P20: a network check that throws counts as offline, sync or async (positive control: online sends)', async () => {
    for (const make of [() => Promise.reject(new Error('plugin gone')), () => { throw new Error('plugin gone'); }]) {
      const w = await createReplayWorld();
      seed(w, 'a');
      await w.queue('inspection.complete', COMPLETE('a'));
      const broken = w.another({ network: { online: make, onChange: () => () => undefined } });
      expect((await broken.replay()).halted).toBe('offline');
      expect(w.server.requests).toHaveLength(0);
      expect((await w.replayer.replay()).sent).toBe(1);
    }
  });

  it('Q2: discard without the explicit confirmation throws at runtime and deletes nothing (positive control: confirmed deletes)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    const untyped = w.replayer.discard as (key: string, options?: unknown) => Promise<boolean>;
    await expect(untyped(row.idempotencyKey)).rejects.toThrow();
    await expect(untyped(row.idempotencyKey, {})).rejects.toThrow();
    await expect(untyped(row.idempotencyKey, { confirmed: false })).rejects.toThrow();
    await expect(untyped(row.idempotencyKey, { confirmed: 'true' })).rejects.toThrow();
    expect(await stateOf(w, row.idempotencyKey)).not.toBeNull();
    expect(await w.replayer.discard(row.idempotencyKey, { confirmed: true })).toBe(true);
    expect(await stateOf(w, row.idempotencyKey)).toBeNull();
  });

  it('Q6: the access token is never logged or reported on the halt path (positive control: the halt happened)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.tokenFn = () => {
      w.state.locked = true;
      return Promise.resolve(GOOD_TOKEN);
    };
    const result = await w.replayer.replay();
    expect(result.halted).toBe('locked');
    expect(JSON.stringify([w.errors.map(String), w.halts, w.progress, result])).not.toContain(GOOD_TOKEN);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('Q11: every request bounds the answer it reads', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    const limits: unknown[] = [];
    const replayer = w.another({
      http: {
        request: (req) => {
          limits.push(req.maxBytes);
          return w.server.http.request(req);
        },
      },
    });
    await replayer.replay();
    expect(limits).toEqual([RESPONSE_MAX_BYTES]);
  });
});

describe('M-6: the pinned origin must be canonical', () => {
  it.each(['https://oi.example.test/', 'https://oi.example.test/api', 'https://OI.example.test', 'http://oi.example.test', 'https://oi.example.test?x=1', 'ftp://oi.example.test', '', 'oi.example.test'])('refuses %s at construction', async (origin) => {
    const w = await createReplayWorld();
    expect(() => w.another({ origin })).toThrow();
  });

  it('accepts a canonical https origin and loopback http; plain http elsewhere only with the development switch', async () => {
    const w = await createReplayWorld();
    expect(() => w.another({ origin: 'https://oi.example.test' })).not.toThrow();
    expect(() => w.another({ origin: 'https://oi.example.test:8443' })).not.toThrow();
    expect(() => w.another({ origin: 'http://localhost:8787' })).not.toThrow();
    expect(() => w.another({ origin: 'http://10.0.2.2:8787' })).toThrow();
    expect(() => w.another({ origin: 'http://10.0.2.2:8787', allowInsecureHttp: true })).not.toThrow();
  });
});

describe('M-7: a client header can never carry credentials, whatever its case', () => {
  it('drops authorization, cookie and proxy-authorization variants and keeps the real token and the version headers', async () => {
    const w = await createReplayWorld({
      clientHeaders: {
        authorization: 'Bearer forged-1',
        AUTHORIZATION: 'Bearer forged-2',
        Cookie: 'sid=1',
        ' proxy-authorization ': 'Basic x',
        'Idempotency-Key': 'forged',
        'idempotency-key': 'forged',
        'X-Client-Platform': 'android',
      },
    });
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    await w.replayer.replay();
    const headers = w.server.requests[0]?.headers ?? {};
    expect(headers).toEqual({ 'X-Client-Platform': 'android', Authorization: `Bearer ${GOOD_TOKEN}`, 'Idempotency-Key': row.idempotencyKey });
  });
});
