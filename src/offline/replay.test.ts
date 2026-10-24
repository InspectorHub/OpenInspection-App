import { describe, expect, it } from 'vitest';
import { discardRow, markOrphaned, readOutboxRow, retryRow } from './outbox';
import { DEFAULT_REGISTRY, INSPECTION_UPDATE, type CommandDef, type CommandRegistry } from './registry';
import { MAX_RETRY_AFTER_MS, MIN_RETRY_DELAY_MS, TARGET_CHECK_BASE_MS } from './replay';
import { ALICE, BOB, createReplayWorld, failure, GOOD_TOKEN, ok, reply, timedOut, unreachable, type ReplayWorld } from './test-support/replay-world';

const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };
const COMPLETE = (id: string) => ({ inspectionId: id });
const UPDATE = (id: string) => ({ inspectionId: id, changes: { sqft: 10 } });

function seed(w: ReplayWorld, ...ids: string[]): void {
  for (const id of ids) w.server.inspections.set(id, { cancelled: false });
}

async function state(w: ReplayWorld, key: string) {
  const row = await readOutboxRow(w.db, key);
  return row === null ? null : { state: row.state, lastError: row.lastError, attempts: row.attempts, nextAt: row.nextAt };
}

describe('a queued write is sent as the registry says', () => {
  it('sends the method, the pinned url, the stable key, the token and the client headers; deletes the row on 2xx', async () => {
    const w = await createReplayWorld();
    seed(w, 'insp-1');
    const row = await w.queue('inspection.update', UPDATE('insp-1'));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, failed: 0, waiting: 0, halted: null, leaseBusy: false });
    expect(w.server.requests).toHaveLength(1);
    const request = w.server.requests[0];
    expect(request?.method).toBe('PATCH');
    expect(request?.url).toBe('https://oi.example.test/api/inspections/insp-1');
    expect(request?.headers).toEqual({
      'X-Client-Platform': 'android',
      'X-Client-Version': '1.2.3',
      Authorization: `Bearer ${GOOD_TOKEN}`,
      'Idempotency-Key': row.idempotencyKey,
      'content-type': 'application/json',
    });
    expect(JSON.parse(request?.body ?? 'null')).toEqual({ sqft: 10 });
    expect(await w.rows()).toEqual([]);
  });

  it('a route without a body sends none and no content type', async () => {
    const w = await createReplayWorld();
    seed(w, 'insp-1');
    await w.queue('inspection.complete', COMPLETE('insp-1'));
    await w.replayer.replay();
    expect(w.server.requests[0]?.body).toBeUndefined();
    expect(w.server.requests[0]?.headers['content-type']).toBeUndefined();
    expect(w.server.requests[0]?.url).toBe('https://oi.example.test/api/inspections/insp-1/complete');
  });

  it('sends the writes of one inspection in queue order: create, update, complete', async () => {
    const w = await createReplayWorld();
    await w.queue('inspection.create', CREATE);
    await w.queue('inspection.update', UPDATE('insp-1'));
    await w.queue('inspection.complete', COMPLETE('insp-1'));
    const result = await w.replayer.replay();
    expect(result.sent).toBe(3);
    expect(w.server.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['POST /api/inspections', 'PATCH /api/inspections/insp-1', 'POST /api/inspections/insp-1/complete']);
    expect(await w.rows()).toEqual([]);
  });

  it('reports progress after every row', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    await w.replayer.replay();
    expect(w.progress).toEqual([
      { sent: 1, failed: 0, waiting: 0 },
      { sent: 2, failed: 0, waiting: 0 },
    ]);
  });

  it('the idempotency key is the same on every attempt of one row', async () => {
    const w = await createReplayWorld();
    seed(w, 'insp-1');
    const row = await w.queue('inspection.complete', COMPLETE('insp-1'));
    w.server.script.push(failure(503, 'UNAVAILABLE'), unreachable(), reply(429, undefined, { retryAfterMs: 1000 }));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await w.replayer.replay();
      w.clock.advance(MAX_RETRY_AFTER_MS);
    }
    expect(w.server.requests).toHaveLength(4);
    expect(new Set(w.server.requests.map((r) => r.headers['Idempotency-Key']))).toEqual(new Set([row.idempotencyKey]));
    expect(await w.rows()).toEqual([]);
  });

  it('a client header cannot replace the authorization or the key', async () => {
    const w = await createReplayWorld({ clientHeaders: { Authorization: 'Bearer forged', 'Idempotency-Key': 'forged' } });
    seed(w, 'insp-1');
    const row = await w.queue('inspection.complete', COMPLETE('insp-1'));
    await w.replayer.replay();
    expect(w.server.requests[0]?.headers.Authorization).toBe(`Bearer ${GOOD_TOKEN}`);
    expect(w.server.requests[0]?.headers['Idempotency-Key']).toBe(row.idempotencyKey);
  });
});

describe('client headers cannot add a second spelling of the headers replay sets itself', () => {
  const names = (headers: Record<string, string>, wanted: string): string[] => Object.keys(headers).filter((name) => name.trim().toLowerCase() === wanted);

  it('a Content-Type or Idempotency-Key of any case never reaches the request; the row sets exactly one of each', async () => {
    const w = await createReplayWorld({
      clientHeaders: { 'CONTENT-TYPE': 'text/evil', 'Content-Type': 'text/evil', ' content-type ': 'text/evil', 'IDEMPOTENCY-KEY': 'forged', 'idempotency-key': 'forged', 'X-Client-Version': '1.2.3' },
    });
    seed(w, 'insp-1');
    const row = await w.queue('inspection.update', UPDATE('insp-1'));
    await w.replayer.replay();
    const headers = w.server.requests[0]?.headers ?? {};
    expect(names(headers, 'content-type')).toEqual(['content-type']);
    expect(headers['content-type']).toBe('application/json');
    expect(names(headers, 'idempotency-key')).toEqual(['Idempotency-Key']);
    expect(headers['Idempotency-Key']).toBe(row.idempotencyKey);
    expect(Object.values(headers)).not.toContain('text/evil');
    expect(Object.values(headers)).not.toContain('forged');
    expect(headers['X-Client-Version']).toBe('1.2.3');
  });
});

describe('P0-9 ordering: strictly per inspection', () => {
  it('a failed write stops only its own inspection; the others go on (positive control: after a retry the held write follows in order)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    const a1 = await w.queue('inspection.update', UPDATE('a'));
    const b1 = await w.queue('inspection.update', UPDATE('b'));
    const a2 = await w.queue('inspection.complete', COMPLETE('a'));
    const b2 = await w.queue('inspection.complete', COMPLETE('b'));
    w.server.script.push(failure(422, 'VALIDATION_ERROR'));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 2, failed: 1 });
    expect(await state(w, a1.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'validation_failed' });
    expect(await state(w, a2.idempotencyKey)).toMatchObject({ state: 'pending' });
    expect(await state(w, b1.idempotencyKey)).toBeNull();
    expect(await state(w, b2.idempotencyKey)).toBeNull();
    expect(w.server.requests.filter((r) => r.url.endsWith('/complete') && r.url.includes('/a/'))).toHaveLength(0);

    expect(await w.replayer.retry(a1.idempotencyKey)).toBe(true);
    await w.replayer.idle();
    expect(await w.rows()).toEqual([]);
    const aRequests = w.server.requests.filter((r) => r.url.includes('/inspections/a'));
    expect(aRequests.map((r) => r.method + (r.url.endsWith('/complete') ? ' complete' : ' update'))).toEqual(['PATCH update', 'PATCH update', 'POST complete']);
  });

  it('a write waiting for a retry holds back the later writes of its own inspection only', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    const a1 = await w.queue('inspection.update', UPDATE('a'));
    const a2 = await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    w.server.script.push(failure(503, 'UNAVAILABLE'));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, waiting: 1, failed: 0 });
    expect(await state(w, a1.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'server_error', attempts: 1 });
    expect(await state(w, a2.idempotencyKey)).toMatchObject({ state: 'pending', lastError: null });
    expect(w.server.requests).toHaveLength(2);
    w.clock.advance(MAX_RETRY_AFTER_MS);
    await w.replayer.replay();
    expect(await w.rows()).toEqual([]);
  });

  it('an orphaned write holds back its own inspection, never the others', async () => {
    const w = await createReplayWorld();
    seed(w, 'b');
    await w.queue('inspection.update', UPDATE('a'));
    const a2 = await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    await markOrphaned(w.db, 'a', ALICE);
    const a3 = await w.queue('inspection.complete', COMPLETE('a'));
    const result = await w.replayer.replay();
    expect(result.sent).toBe(1);
    expect(w.server.requests.map((r) => r.url)).toEqual(['https://oi.example.test/api/inspections/b/complete']);
    expect(await state(w, a2.idempotencyKey)).toMatchObject({ state: 'orphaned', lastError: 'target_gone' });
    expect(await state(w, a3.idempotencyKey)).toMatchObject({ state: 'pending' });
  });

  it('writes without an inspection id keep one global order, and do not hold back inspection writes', async () => {
    const note: CommandDef = {
      op: 'device.note',
      method: 'POST',
      pathTemplate: '/api/notes',
      scope: 'global',
      idempotency: 'safe_to_repeat',
      neverBlock: true,
      registryVersion: 1,
      parse: (input) => ({ text: typeof input === 'object' && input !== null && 'text' in input ? String(input.text) : '' }),
      inspectionIdOf: () => null,
      body: (payload) => payload,
      sample: { text: 'x' },
    };
    const registry: CommandRegistry = [...DEFAULT_REGISTRY, note];
    const w = await createReplayWorld({ registry });
    seed(w, 'a');
    const n1 = await w.queue('device.note', { text: 'one' });
    const n2 = await w.queue('device.note', { text: 'two' });
    await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(422, 'VALIDATION_ERROR'));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(await state(w, n1.idempotencyKey)).toMatchObject({ state: 'failed' });
    expect(await state(w, n2.idempotencyKey)).toMatchObject({ state: 'pending' });
    expect(w.server.requests).toHaveLength(2);
    expect(w.server.requests[0]?.url).toBe('https://oi.example.test/api/notes');
  });

  it('writes of two accounts are separate lines: the other account\'s failed head does not hold back mine', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const bobs = await w.queue('inspection.complete', COMPLETE('a'), BOB);
    await w.queue('inspection.complete', COMPLETE('a'), ALICE);
    await w.db.run("UPDATE outbox SET state = 'failed', last_error = 'rejected' WHERE idempotency_key = ?", [bobs.idempotencyKey]);
    const result = await w.replayer.replay();
    expect(result.sent).toBe(1);
  });
});

describe('P0-9 triage: one test per answer', () => {
  it('200 on a create replay is a success: the row goes and the local package is confirmed in the same step', async () => {
    const w = await createReplayWorld();
    w.server.inspections.set('insp-1', { cancelled: false });
    await w.queue('inspection.create', CREATE);
    expect(await w.db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 0 }]);
    const result = await w.replayer.replay();
    expect(result.sent).toBe(1);
    expect(w.server.requests).toHaveLength(1);
    expect(await w.rows()).toEqual([]);
    expect(await w.db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 1 }]);
  });

  it('201 on a fresh create is the same success', async () => {
    const w = await createReplayWorld();
    await w.queue('inspection.create', CREATE);
    await w.replayer.replay();
    expect(w.server.inspections.has('insp-1')).toBe(true);
    expect(await w.rows()).toEqual([]);
    expect(await w.db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 1 }]);
  });

  it('a create answered with another inspection id is failed, not confirmed', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    w.server.script.push(ok('somebody-else'));
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'unexpected_response' });
    expect(await w.db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 0 }]);
  });

  it('a 200 that is not the server\'s envelope (a captive portal page) never deletes the write (positive control: the real envelope does)', async () => {
    const w = await createReplayWorld();
    seed(w, 'insp-1');
    const row = await w.queue('inspection.complete', COMPLETE('insp-1'));
    w.server.script.push(reply(200, undefined, { text: '<html>Sign in to Wi-Fi</html>' }), reply(200, { hello: 'world' }));
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'server_error', attempts: 1 });
    w.clock.advance(MAX_RETRY_AFTER_MS);
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 2 });
    w.clock.advance(MAX_RETRY_AFTER_MS);
    await w.replayer.replay();
    expect(await w.rows()).toEqual([]);
  });

  it('401: refreshes the session once and sends again', async () => {
    const w = await createReplayWorld();
    seed(w, 'insp-1');
    await w.queue('inspection.complete', COMPLETE('insp-1'));
    w.state.token = 'stale-token';
    w.state.onCheckSession = () => {
      w.state.token = GOOD_TOKEN;
    };
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, halted: null });
    expect(w.server.requests.map((r) => r.headers.Authorization)).toEqual(['Bearer stale-token', `Bearer ${GOOD_TOKEN}`]);
    expect(w.checkSession).toHaveBeenCalledTimes(1);
    expect(w.server.requests[0]?.headers['Idempotency-Key']).toBe(w.server.requests[1]?.headers['Idempotency-Key']);
  });

  it('401 that survives the refresh halts "re-login required", keeps every row and stops the run', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    const a = await w.queue('inspection.complete', COMPLETE('a'));
    const b = await w.queue('inspection.complete', COMPLETE('b'));
    w.state.token = 'stale-token';
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 0, failed: 0, halted: 'auth' });
    expect(w.halts).toEqual(['auth']);
    expect(w.server.requests).toHaveLength(2);
    expect(await state(w, a.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0, lastError: null });
    expect(await state(w, b.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('a session the server ended (checkSession says relogin) halts at once, with rows kept', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.token = 'stale-token';
    w.state.session = { kind: 'relogin' };
    const result = await w.replayer.replay();
    expect(result.halted).toBe('auth');
    expect(w.server.requests).toHaveLength(1);
    expect(await w.rows()).toHaveLength(1);
  });

  it('no access token at all halts without a request', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.complete', COMPLETE('a'));
    w.state.token = null;
    const result = await w.replayer.replay();
    expect(result.halted).toBe('auth');
    expect(w.server.requests).toHaveLength(0);
    expect(await w.rows()).toHaveLength(1);
  });

  it('426 halts only a write the version guard can refuse; the row stays pending and is not counted', async () => {
    const guarded: CommandDef = { ...INSPECTION_UPDATE, op: 'inspection.estimate', neverBlock: false };
    const w = await createReplayWorld({ registry: [...DEFAULT_REGISTRY, guarded] });
    seed(w, 'a', 'b');
    const g = await w.queue('inspection.estimate', UPDATE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    w.server.script.push(reply(426, { success: false, error: { code: 'UPGRADE_REQUIRED', message: 'x' } }));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 0, failed: 0, halted: 'upgrade' });
    expect(w.halts).toEqual(['upgrade']);
    expect(w.server.requests).toHaveLength(1);
    expect(await state(w, g.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0, lastError: null });
  });

  it('426 on a never-block write is not a reason to stop: it waits like a server error and the others go on', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    const a = await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    w.server.script.push(reply(426));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, waiting: 1, halted: null });
    expect(w.halts).toEqual([]);
    expect(await state(w, a.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'server_error' });
  });

  it('429 waits for Retry-After, clamps it, and is not a failure', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b', 'c');
    const a = await w.queue('inspection.complete', COMPLETE('a'));
    const b = await w.queue('inspection.complete', COMPLETE('b'));
    const c = await w.queue('inspection.complete', COMPLETE('c'));
    const t0 = w.clock.now();
    w.server.script.push(reply(429, undefined, { retryAfterMs: 5000 }), reply(429, undefined, { retryAfterMs: 99 * 3_600_000 }), reply(429, undefined, { retryAfterMs: 0 }));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 0, failed: 0, waiting: 3 });
    expect((await state(w, a.idempotencyKey))?.nextAt).toBe(t0 + 5000);
    expect((await state(w, b.idempotencyKey))?.nextAt).toBe(t0 + MAX_RETRY_AFTER_MS);
    expect((await state(w, c.idempotencyKey))?.nextAt).toBeGreaterThanOrEqual(t0 + MIN_RETRY_DELAY_MS);
    expect(await state(w, a.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'rate_limited' });
    // Not due yet: nothing is sent.
    await w.replayer.replay();
    expect(w.server.requests).toHaveLength(3);
    w.clock.advance(5000);
    await w.replayer.replay();
    expect(await state(w, a.idempotencyKey)).toBeNull();
    expect(await state(w, b.idempotencyKey)).not.toBeNull();
  });

  it.each([
    ['500', failure(500, 'INTERNAL')],
    ['502', reply(502)],
    ['503 with Retry-After', reply(503, undefined, { retryAfterMs: 7000 })],
    ['408', reply(408)],
  ])('%s waits and retries; it is never counted as failed', async (_name, answer) => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(answer);
    const t0 = w.clock.now();
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 0, failed: 0, waiting: 1 });
    const after = await state(w, row.idempotencyKey);
    expect(after).toMatchObject({ state: 'pending', lastError: 'server_error', attempts: 1 });
    expect(after?.nextAt).toBeGreaterThanOrEqual(t0 + MIN_RETRY_DELAY_MS);
  });

  it.each([
    ['a network error', unreachable()],
    ['a timeout', timedOut()],
  ])('%s waits and retries with backoff', async (_name, error) => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(error);
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'network', attempts: 1 });
  });

  it('transient trouble never gives up: after many failed attempts the write is still pending, and then it goes through', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    const delays: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      w.server.script.push(i % 2 === 0 ? failure(503, 'UNAVAILABLE') : unreachable());
      await w.replayer.replay();
      const after = await readOutboxRow(w.db, row.idempotencyKey);
      expect(after?.state).toBe('pending');
      delays.push((after?.nextAt ?? 0) - w.clock.now());
      w.clock.advance(MAX_RETRY_AFTER_MS);
    }
    expect(delays.every((d) => d >= MIN_RETRY_DELAY_MS && d <= MAX_RETRY_AFTER_MS)).toBe(true);
    expect(delays[10] ?? 0).toBeGreaterThan(delays[0] ?? 0);
    expect((await readOutboxRow(w.db, row.idempotencyKey))?.attempts).toBe(25);
    await w.replayer.replay();
    expect(await w.rows()).toEqual([]);
  });

  it.each([
    ['404', 404],
    ['403', 403],
  ])('%s on a write for an inspection asks for a check, keeps the write pending, and holds only that inspection', async (_name, status) => {
    const w = await createReplayWorld();
    seed(w, 'b');
    if (status === 403) {
      seed(w, 'a');
      w.server.forbidden.add('a');
    }
    const a1 = await w.queue('inspection.complete', COMPLETE('a'));
    const a2 = await w.queue('inspection.update', UPDATE('a'));
    const b1 = await w.queue('inspection.complete', COMPLETE('b'));
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, failed: 0, waiting: 1 });
    expect(w.reconciles).toEqual(['a']);
    expect(await state(w, a1.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'target_not_visible', attempts: 1 });
    expect(await state(w, a2.idempotencyKey)).toMatchObject({ state: 'pending', lastError: null, attempts: 0 });
    expect(await state(w, b1.idempotencyKey)).toBeNull();
    expect(w.server.requests.map((r) => r.url)).toEqual(['https://oi.example.test/api/inspections/a/complete', 'https://oi.example.test/api/inspections/b/complete']);
  });

  it('a still-visible inspection is asked again slowly, never given up on, and the write then goes through (bounded retry)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    w.server.hidden.add('a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    const waits: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      await w.replayer.replay();
      const after = await readOutboxRow(w.db, row.idempotencyKey);
      expect(after).toMatchObject({ state: 'pending', lastError: 'target_not_visible' });
      waits.push((after?.nextAt ?? 0) - w.clock.now());
      w.clock.advance(MAX_RETRY_AFTER_MS);
    }
    expect(waits[0] ?? 0).toBeGreaterThanOrEqual(TARGET_CHECK_BASE_MS / 2);
    expect(waits.every((d) => d <= MAX_RETRY_AFTER_MS)).toBe(true);
    expect(waits.slice(1).every((d, i) => d >= (waits[i] ?? 0))).toBe(true);
    expect(waits[13]).toBe(Math.round(MAX_RETRY_AFTER_MS * 0.75));
    expect(w.reconciles).toHaveLength(14);
    w.server.hidden.delete('a');
    await w.replayer.replay();
    expect(await w.rows()).toEqual([]);
  });

  it('404 on a create is a refusal of the create, not a missing target', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    w.server.script.push(failure(404, 'NOT_FOUND'));
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'rejected' });
    expect(w.reconciles).toEqual([]);
  });

  it('409 IDEMPOTENCY_IN_FLIGHT is retried shortly and is not a failure', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.server.script.push(failure(409, 'IDEMPOTENCY_IN_FLIGHT'));
    const t0 = w.clock.now();
    await w.replayer.replay();
    const after = await state(w, row.idempotencyKey);
    expect(after).toMatchObject({ state: 'pending', lastError: 'in_flight' });
    expect((after?.nextAt ?? 0) - t0).toBeLessThan(10_000);
    w.clock.advance(10_000);
    await w.replayer.replay();
    expect(await w.rows()).toEqual([]);
  });

  it.each([
    ['409 ID_CONFLICT', failure(409, 'ID_CONFLICT'), 'id_conflict'],
    ['409 anything else', failure(409, 'SOMETHING_ELSE'), 'conflict'],
    ['409 without a body', reply(409), 'conflict'],
    ['422 IDEMPOTENCY_KEY_REUSED', failure(422, 'IDEMPOTENCY_KEY_REUSED'), 'key_reused'],
    ['422 validation', failure(422, 'VALIDATION_ERROR'), 'validation_failed'],
    ['400 HOLIDAY_BLOCKED', failure(400, 'HOLIDAY_BLOCKED'), 'holiday_blocked'],
    ['400 validation', failure(400, 'VALIDATION_ERROR'), 'validation_failed'],
    ['402 quota', failure(402, 'QUOTA_EXHAUSTED'), 'quota_refused'],
    ['403 quota', failure(403, 'QUOTA_EXHAUSTED'), 'quota_refused'],
    ['418', failure(418, 'TEAPOT'), 'rejected'],
  ])('%s becomes failed with a fixed code and stops its inspection', async (_name, answer, code) => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    const later = await w.queue('inspection.update', UPDATE('insp-1'));
    w.server.script.push(answer);
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: code, attempts: 0 });
    expect(await state(w, later.idempotencyKey)).toMatchObject({ state: 'pending' });
    expect(w.server.requests).toHaveLength(1);
    expect(w.reconciles).toEqual([]);
  });

  it('400 on completing a cancelled inspection is failed with its own code', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    w.server.inspections.set('a', { cancelled: true });
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'inspection_cancelled' });
  });

  it('a quota refusal on an update is also failed (not only on a create)', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.update', UPDATE('a'));
    w.server.script.push(failure(402, 'QUOTA_EXHAUSTED'));
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'quota_refused' });
  });

  it('no wording of the server reaches the stored row, the halts or the error sink', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    w.server.script.push(failure(409, 'ID_CONFLICT', 'SECRET wording from the server'));
    await w.replayer.replay();
    const dump = JSON.stringify([await w.db.query('SELECT * FROM outbox'), w.errors, w.halts, w.reconciles]);
    expect(dump).not.toContain('SECRET');
    expect((await readOutboxRow(w.db, row.idempotencyKey))?.lastError).toBe('id_conflict');
  });
});

describe('unreadable rows are failed and kept; the loop goes on', () => {
  it('an unknown op and an unknown registry version', async () => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b', 'c');
    const unknown = await w.queue('inspection.complete', COMPLETE('a'));
    const versioned = await w.queue('inspection.complete', COMPLETE('b'));
    await w.queue('inspection.complete', COMPLETE('c'));
    await w.db.run("UPDATE outbox SET op = 'inspection.archive' WHERE idempotency_key = ?", [unknown.idempotencyKey]);
    await w.db.run('UPDATE outbox SET registry_version = 7 WHERE idempotency_key = ?', [versioned.idempotencyKey]);
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, failed: 2 });
    expect(await state(w, unknown.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'unknown_op' });
    expect(await state(w, versioned.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'unknown_registry_version' });
    expect(w.server.requests).toHaveLength(1);
  });

  it.each([
    ['text that is not JSON', 'not json {', 'a'],
    ['JSON of the wrong shape', '{"inspectionId": 5}', 'a'],
    ['a payload for another inspection than the column says', '{"inspectionId":"zzz"}', 'a'],
    ['a payload with a path-like id', '{"inspectionId":"../admin"}', '../admin'],
  ])('a corrupt payload (%s) is failed as corrupt_payload, its raw text is kept, and no request is made for it', async (_name, payload, column) => {
    const w = await createReplayWorld();
    seed(w, 'a', 'b');
    const bad = await w.queue('inspection.complete', COMPLETE('a'));
    await w.queue('inspection.complete', COMPLETE('b'));
    await w.db.run('UPDATE outbox SET payload = ?, inspection_id = ? WHERE idempotency_key = ?', [payload, column, bad.idempotencyKey]);
    const result = await w.replayer.replay();
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    const after = await readOutboxRow(w.db, bad.idempotencyKey);
    expect(after).toMatchObject({ state: 'failed', lastError: 'corrupt_payload', payload });
    expect(w.server.requests).toHaveLength(1);
    expect(w.server.requests[0]?.url).toContain('/inspections/b/');
  });

  it('an inspection-bound write with no inspection id column is failed, never sent without its line', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    await w.db.run('UPDATE outbox SET inspection_id = NULL WHERE idempotency_key = ?', [row.idempotencyKey]);
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'corrupt_payload' });
    expect(w.server.requests).toHaveLength(0);
  });

  it('a poisoned write is visible: it stays with its code, can be counted, retried and, with confirmation, discarded', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.update', UPDATE('a'));
    w.server.script.push(failure(422, 'VALIDATION_ERROR'));
    await w.replayer.replay();
    expect((await w.rows()).map((r) => [r.state, r.lastError])).toEqual([['failed', 'validation_failed']]);
    await expect(discardRow(w.db, row.idempotencyKey, { confirmed: false as unknown as true })).rejects.toThrow(/confirmation/);
    expect(await w.rows()).toHaveLength(1);
    expect(await retryRow(w.db, row.idempotencyKey)).toBe(true);
    w.server.script.push(failure(422, 'VALIDATION_ERROR'));
    await w.replayer.replay();
    expect(await w.replayer.discard(row.idempotencyKey, { confirmed: true })).toBe(true);
    expect(await w.rows()).toEqual([]);
  });
});

describe('crash safety and the 25 hour case', () => {
  it('a create whose answer was lost, replayed after the server forgot the key, answers 200 and is not duplicated', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    // The server applied the create, and the answer never arrived.
    w.server.inspections.set('insp-1', { cancelled: false });
    w.server.keys.set(row.idempotencyKey, reply(201, { success: true, data: { inspection: { id: 'insp-1' } } }));
    w.server.script.push(unreachable());
    await w.replayer.replay();
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'network' });
    w.clock.advance(25 * 3_600_000);
    w.server.forgetKeys();
    const result = await w.replayer.replay();
    expect(result.sent).toBe(1);
    expect(w.server.requests).toHaveLength(2);
    expect(w.server.inspections.size).toBe(1);
    expect(await w.rows()).toEqual([]);
    expect(await w.db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 1 }]);
  });

  it('a failure between the 2xx and the delete leaves the row, and the next run is safe (the create answers 200 for its id)', async () => {
    const w = await createReplayWorld();
    const row = await w.queue('inspection.create', CREATE);
    let broken = true;
    const transaction = w.db.transaction.bind(w.db);
    w.db.transaction = (fn) =>
      transaction((tx) =>
        fn({
          ...tx,
          run: (sql, params) => (broken && sql.startsWith('UPDATE work_package') ? Promise.reject(new Error('disk I/O error')) : tx.run(sql, params)),
        }),
      );
    await w.replayer.replay();
    expect(w.errors).toHaveLength(1);
    expect(await state(w, row.idempotencyKey)).toMatchObject({ state: 'pending' });
    expect(await w.db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 0 }]);
    expect(w.server.inspections.has('insp-1')).toBe(true);
    broken = false;
    await w.replayer.replay();
    expect(w.server.requests).toHaveLength(2);
    expect(w.server.inspections.size).toBe(1);
    expect(await w.rows()).toEqual([]);
    expect(await w.db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 1 }]);
  });

  it('a row discarded while its request is in flight is not resurrected or counted', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.complete', COMPLETE('a'));
    w.server.hook = async () => {
      await discardRow(w.db, row.idempotencyKey, { confirmed: true });
    };
    const result = await w.replayer.replay();
    expect(await w.rows()).toEqual([]);
    expect(result.failed).toBe(0);
  });
});
