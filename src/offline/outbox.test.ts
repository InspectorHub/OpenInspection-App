import { beforeEach, describe, expect, it } from 'vitest';
import { createManualClock, type ManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import {
  OutboxError,
  accountKey,
  completeRow,
  countFailed,
  discardRow,
  enqueue,
  listOutbox,
  markFailed,
  markOrphaned,
  markWaiting,
  outboxCounts,
  outboxCountsByInspection,
  readOutboxRow,
  retryRow,
  unorphan,
  type Account,
  type OutboxDeps,
} from './outbox';
import { INSPECTION_CREATE, MAX_PAYLOAD_BYTES, RegistryError, payloadBytes, type CommandDef, type CommandRegistry } from './registry';
import { countOrphanedOutbox, countWaitingUploads } from './waiting';

const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
const BOB: Account = { tenantId: 'tenant-1', userId: 'bob' };
const CREATE = { id: 'insp-1', propertyAddress: '12 Test Street', templateId: 'template-1' };

let db: Db;
let clock: ManualClock;
let ids: number;
let deps: OutboxDeps;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  clock = createManualClock(5000);
  ids = 0;
  deps = { db, clock, newId: () => `id-${String((ids += 1))}` };
});

describe('enqueue', () => {
  it('stores the validated row with its stable key, account, registry version and inspection id', async () => {
    const row = await enqueue(deps, 'inspection.update', { inspectionId: 'insp-1', changes: { sqft: 10, status: 'cancelled' }, tenantId: 'x' }, { account: ALICE });
    expect(row).toMatchObject({
      idempotencyKey: 'id-1',
      seq: 1,
      op: 'inspection.update',
      state: 'pending',
      lastError: null,
      createdAt: 5000,
      inspectionId: 'insp-1',
      registryVersion: 1,
      tenantId: 'tenant-1',
      userId: 'alice',
      attempts: 0,
      nextAt: null,
    });
    expect(JSON.parse(row.payload)).toEqual({ inspectionId: 'insp-1', changes: { sqft: 10 } });
    expect(await readOutboxRow(db, 'id-1')).toEqual(row);
  });

  it('allocates distinct increasing seq values for two enqueues in the same tick', async () => {
    const [a, b, c] = await Promise.all([
      enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE }),
      enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE }),
      enqueue(deps, 'inspection.complete', { inspectionId: 'c' }, { account: ALICE }),
    ]);
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(new Set([a.idempotencyKey, b.idempotencyKey, c.idempotencyKey]).size).toBe(3);
  });

  it('never hands out a seq twice, even after the newest row was sent and deleted', async () => {
    const first = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    const second = await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE });
    await completeRow(db, second, false);
    const third = await enqueue(deps, 'inspection.complete', { inspectionId: 'c' }, { account: ALICE });
    expect([first.seq, second.seq, third.seq]).toEqual([1, 2, 3]);
  });

  it('Q11: a payload over the byte cap is refused at enqueue and nothing is stored (positive control: the cap itself is stored)', async () => {
    const wide: CommandDef = { ...INSPECTION_CREATE, parse: (input) => input as Record<string, unknown> };
    const registry: CommandRegistry = [wide];
    const base = payloadBytes({ id: 'big-1', blob: '' });
    const over = enqueue({ ...deps, registry }, 'inspection.create', { id: 'big-1', blob: 'x'.repeat(MAX_PAYLOAD_BYTES - base + 1) }, { account: ALICE });
    await expect(over).rejects.toMatchObject({ code: 'payload_too_large' });
    expect(await listOutbox(db)).toEqual([]);
    expect(await db.query('SELECT inspection_id FROM work_package')).toEqual([]);
    const atCap = await enqueue({ ...deps, registry }, 'inspection.create', { id: 'big-1', blob: 'x'.repeat(MAX_PAYLOAD_BYTES - base) }, { account: ALICE });
    expect(atCap.inspectionId).toBe('big-1');
  });

  it('I4: the counter wiped or lagging below an existing seq never makes the next seq reuse one', async () => {
    await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'c' }, { account: ALICE });
    await db.run("DELETE FROM device_state WHERE key = 'outbox_seq'");
    const afterWipe = await enqueue(deps, 'inspection.complete', { inspectionId: 'd' }, { account: ALICE });
    expect(afterWipe.seq).toBe(4);
    await db.run("UPDATE device_state SET value = '1' WHERE key = 'outbox_seq'");
    const afterLag = await enqueue(deps, 'inspection.complete', { inspectionId: 'e' }, { account: ALICE });
    expect(afterLag.seq).toBe(5);
    await db.run("UPDATE device_state SET value = 'not a number' WHERE key = 'outbox_seq'");
    expect((await enqueue(deps, 'inspection.complete', { inspectionId: 'f' }, { account: ALICE })).seq).toBe(6);
    expect((await listOutbox(db)).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a create stores the local work package, unconfirmed, in the same transaction', async () => {
    const row = await enqueue(deps, 'inspection.create', CREATE, { account: ALICE });
    expect(row.inspectionId).toBe('insp-1');
    expect(await db.query('SELECT inspection_id, server_confirmed, tenant_id, user_id, refreshed_at, purging, package_gen FROM work_package')).toEqual([
      { inspection_id: 'insp-1', server_confirmed: 0, tenant_id: 'tenant-1', user_id: 'alice', refreshed_at: 0, purging: 0, package_gen: 0 },
    ]);
  });

  it('a create without an id gets a generated one, used for the payload, the row and the package', async () => {
    const row = await enqueue(deps, 'inspection.create', { propertyAddress: '12 Test Street', templateId: 't' }, { account: ALICE });
    expect(row.inspectionId).toBe('id-1');
    expect(JSON.parse(row.payload).id).toBe('id-1');
    expect(row.idempotencyKey).toBe('id-2');
    expect(await db.query('SELECT inspection_id FROM work_package')).toEqual([{ inspection_id: 'id-1' }]);
  });

  it('writes nothing when the row insert fails: no half-written pair (positive control: the same call succeeds without the fault)', async () => {
    const failing: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            run: (sql, params) => (sql.includes('INSERT INTO outbox') ? Promise.reject(new Error('disk I/O error')) : tx.run(sql, params)),
          }),
        ),
    };
    await expect(enqueue({ ...deps, db: failing }, 'inspection.create', CREATE, { account: ALICE })).rejects.toBeInstanceOf(OutboxError);
    expect(await db.query('SELECT count(*) AS n FROM work_package')).toEqual([{ n: 0 }]);
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 0 }]);
    await enqueue(deps, 'inspection.create', CREATE, { account: ALICE });
    expect(await db.query('SELECT count(*) AS n FROM work_package')).toEqual([{ n: 1 }]);
  });

  it('retries once when the unique index on seq collides, and keeps the write', async () => {
    let failures = 1;
    const flaky: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            run: (sql, params) => {
              if (sql.includes('INSERT INTO outbox') && failures > 0) {
                failures -= 1;
                return Promise.reject(new Error('UNIQUE constraint failed: outbox.seq'));
              }
              return tx.run(sql, params);
            },
          }),
        ),
    };
    const row = await enqueue({ ...deps, db: flaky }, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    expect(row.seq).toBe(1);
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 1 }]);
  });

  it('gives up after the retry with a fixed error and writes nothing', async () => {
    const broken: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            run: (sql, params) => (sql.includes('INSERT INTO outbox') ? Promise.reject(new Error('UNIQUE constraint failed: outbox.seq')) : tx.run(sql, params)),
          }),
        ),
    };
    const failure = await enqueue({ ...deps, db: broken }, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(OutboxError);
    expect((failure as OutboxError).code).toBe('enqueue_failed');
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 0 }]);
  });

  it('refuses an invalid command with a RegistryError and stores nothing', async () => {
    await expect(enqueue(deps, 'inspection.complete', { inspectionId: '../x' }, { account: ALICE })).rejects.toBeInstanceOf(RegistryError);
    await expect(enqueue(deps, 'inspection.archive', {}, { account: ALICE })).rejects.toBeInstanceOf(RegistryError);
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 0 }]);
    expect(await db.query('SELECT count(*) AS n FROM work_package')).toEqual([{ n: 0 }]);
  });

  it('refuses an account without a tenant or user', async () => {
    await expect(enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: { tenantId: '', userId: 'u' } })).rejects.toMatchObject({ code: 'invalid_account' });
    await expect(enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: { tenantId: 't', userId: 'u'.repeat(257) } })).rejects.toMatchObject({ code: 'invalid_account' });
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 0 }]);
  });

  it('a create for an id another account owns locally is refused; the same account may repeat it', async () => {
    await enqueue(deps, 'inspection.create', CREATE, { account: ALICE });
    await expect(enqueue(deps, 'inspection.create', CREATE, { account: BOB })).rejects.toMatchObject({ code: 'id_in_use' });
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 1 }]);
    await enqueue(deps, 'inspection.create', CREATE, { account: ALICE });
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 2 }]);
    expect(await db.query('SELECT count(*) AS n FROM work_package')).toEqual([{ n: 1 }]);
  });

  it('does not downgrade a package the server already confirmed', async () => {
    await db.run('INSERT INTO work_package (inspection_id, refreshed_at, server_confirmed, tenant_id, user_id) VALUES (?, 1, 1, ?, ?)', ['insp-1', 'tenant-1', 'alice']);
    await enqueue(deps, 'inspection.create', CREATE, { account: ALICE });
    expect(await db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 1 }]);
  });
});

describe('listing and counting', () => {
  it('lists in queue order, filtered by account, inspection and state', async () => {
    await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: BOB });
    const third = await enqueue(deps, 'inspection.update', { inspectionId: 'a', changes: { sqft: 1 } }, { account: ALICE });
    await markFailed(db, third.idempotencyKey, 'rejected');
    expect((await listOutbox(db)).map((r) => r.seq)).toEqual([1, 2, 3]);
    expect((await listOutbox(db, { account: ALICE })).map((r) => r.seq)).toEqual([1, 3]);
    expect((await listOutbox(db, { inspectionId: 'a', states: ['failed'] })).map((r) => r.seq)).toEqual([3]);
  });

  it('counts pending, failed, orphaned and needs-check apart, per account and per inspection', async () => {
    const a1 = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    const a2 = await enqueue(deps, 'inspection.update', { inspectionId: 'a', changes: { sqft: 1 } }, { account: ALICE });
    const b1 = await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'c' }, { account: BOB });
    await markFailed(db, a1.idempotencyKey, 'conflict');
    await markWaiting(db, a2.idempotencyKey, 'target_not_visible', 9000);
    await db.run("UPDATE outbox SET state = 'orphaned', last_error = 'target_gone' WHERE idempotency_key = ?", [b1.idempotencyKey]);
    expect(await outboxCounts(db, { account: ALICE })).toEqual({ pending: 1, failed: 1, orphaned: 1, needsCheck: 1 });
    expect(await outboxCounts(db, { account: BOB })).toEqual({ pending: 1, failed: 0, orphaned: 0, needsCheck: 0 });
    expect(await outboxCounts(db, { account: ALICE, inspectionId: 'a' })).toEqual({ pending: 1, failed: 1, orphaned: 0, needsCheck: 1 });
    expect(await outboxCountsByInspection(db, { account: ALICE })).toEqual({
      a: { pending: 1, failed: 1, orphaned: 0, needsCheck: 0 },
      b: { pending: 0, failed: 0, orphaned: 1, needsCheck: 0 },
    });
    expect(await countFailed(db, { account: ALICE })).toBe(1);
    expect(await countFailed(db, { account: BOB })).toBe(0);
  });

  it('the account key is unambiguous', () => {
    expect(accountKey({ tenantId: 'a:b', userId: 'c' })).not.toBe(accountKey({ tenantId: 'a', userId: 'b:c' }));
    expect(accountKey(ALICE)).toBe('tenant-1:alice');
  });
});

describe('state changes', () => {
  it('markOrphaned moves the pending rows of one inspection, only for the asked account, and leaves the rest (a failed row stays failed, with its own code)', async () => {
    const a1 = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    const a2 = await enqueue(deps, 'inspection.update', { inspectionId: 'a', changes: { sqft: 1 } }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: BOB });
    await markFailed(db, a2.idempotencyKey, 'conflict');
    expect(await markOrphaned(db, 'a', ALICE)).toBe(1);
    expect((await readOutboxRow(db, a1.idempotencyKey))?.state).toBe('orphaned');
    expect((await readOutboxRow(db, a1.idempotencyKey))?.lastError).toBe('target_gone');
    expect(await readOutboxRow(db, a2.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'conflict' });
    expect(await outboxCounts(db, { account: BOB })).toEqual({ pending: 1, failed: 0, orphaned: 0, needsCheck: 0 });
    expect(await outboxCounts(db, { account: ALICE, inspectionId: 'b' })).toEqual({ pending: 1, failed: 0, orphaned: 0, needsCheck: 0 });
  });

  it('M-8 / Q23: a failed row is never overwritten by markOrphaned and never resurrected by unorphan', async () => {
    const failed = await enqueue(deps, 'inspection.update', { inspectionId: 'a', changes: { sqft: 1 } }, { account: ALICE });
    const pending = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    await markFailed(db, failed.idempotencyKey, 'validation_failed');
    expect(await markOrphaned(db, 'a', ALICE)).toBe(1);
    expect(await readOutboxRow(db, failed.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'validation_failed' });
    expect(await readOutboxRow(db, pending.idempotencyKey)).toMatchObject({ state: 'orphaned', lastError: 'target_gone' });
    expect(await unorphan(db, 'a', ALICE)).toBe(1);
    expect(await readOutboxRow(db, failed.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'validation_failed' });
    expect(await readOutboxRow(db, pending.idempotencyKey)).toMatchObject({ state: 'pending', lastError: null });
  });

  it('M-8: unorphan reverses only what markOrphaned marked (target_gone); an orphaned row with another code is left alone', async () => {
    const marked = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    const other = await enqueue(deps, 'inspection.update', { inspectionId: 'a', changes: { sqft: 1 } }, { account: ALICE });
    await db.run("UPDATE outbox SET state = 'orphaned', last_error = 'target_gone' WHERE idempotency_key = ?", [marked.idempotencyKey]);
    await db.run("UPDATE outbox SET state = 'orphaned', last_error = 'corrupt_payload' WHERE idempotency_key = ?", [other.idempotencyKey]);
    expect(await unorphan(db, 'a', ALICE)).toBe(1);
    expect((await readOutboxRow(db, marked.idempotencyKey))?.state).toBe('pending');
    expect(await readOutboxRow(db, other.idempotencyKey)).toMatchObject({ state: 'orphaned', lastError: 'corrupt_payload' });
  });

  it('unorphan puts orphaned rows back to pending', async () => {
    const row = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    await markOrphaned(db, 'a');
    expect(await unorphan(db, 'a', BOB)).toBe(0);
    expect(await unorphan(db, 'a', ALICE)).toBe(1);
    expect(await readOutboxRow(db, row.idempotencyKey)).toMatchObject({ state: 'pending', lastError: null, attempts: 0, nextAt: null });
  });

  it('markFailed and markWaiting only touch pending rows', async () => {
    const row = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    expect(await markWaiting(db, row.idempotencyKey, 'network', 9000)).toBe(true);
    expect(await readOutboxRow(db, row.idempotencyKey)).toMatchObject({ state: 'pending', lastError: 'network', attempts: 1, nextAt: 9000 });
    expect(await markFailed(db, row.idempotencyKey, 'rejected')).toBe(true);
    expect(await markFailed(db, row.idempotencyKey, 'conflict')).toBe(false);
    expect(await markWaiting(db, row.idempotencyKey, 'network', 9000)).toBe(false);
    expect(await readOutboxRow(db, row.idempotencyKey)).toMatchObject({ state: 'failed', lastError: 'rejected', attempts: 0, nextAt: null });
  });

  it('retryRow puts a failed row back and makes a waiting row due; an orphaned or missing one is left alone', async () => {
    const failed = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    const waiting = await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE });
    const orphan = await enqueue(deps, 'inspection.complete', { inspectionId: 'c' }, { account: ALICE });
    await markFailed(db, failed.idempotencyKey, 'rejected');
    await markWaiting(db, waiting.idempotencyKey, 'rate_limited', 99_999);
    await markOrphaned(db, 'c');
    expect(await retryRow(db, failed.idempotencyKey)).toBe(true);
    expect(await retryRow(db, waiting.idempotencyKey)).toBe(true);
    expect(await retryRow(db, orphan.idempotencyKey)).toBe(false);
    expect(await retryRow(db, 'missing')).toBe(false);
    expect(await readOutboxRow(db, failed.idempotencyKey)).toMatchObject({ state: 'pending', lastError: null, attempts: 0 });
    expect(await readOutboxRow(db, waiting.idempotencyKey)).toMatchObject({ state: 'pending', nextAt: null, attempts: 0 });
  });

  it('discard needs an explicit confirmation and deletes only that row', async () => {
    const one = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE });
    // @ts-expect-error the confirmation is required by the type as well as at run time
    await expect(discardRow(db, one.idempotencyKey, {})).rejects.toThrow(/confirmation/);
    // @ts-expect-error a falsy confirmation is not one
    await expect(discardRow(db, one.idempotencyKey, { confirmed: false })).rejects.toThrow(/confirmation/);
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 2 }]);
    expect(await discardRow(db, one.idempotencyKey, { confirmed: true })).toBe(true);
    expect(await discardRow(db, one.idempotencyKey, { confirmed: true })).toBe(false);
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 1 }]);
  });

  it('completeRow deletes the row and, for a create, confirms the package of the same account only', async () => {
    const row = await enqueue(deps, 'inspection.create', CREATE, { account: ALICE });
    await completeRow(db, row, true);
    expect(await db.query('SELECT server_confirmed FROM work_package')).toEqual([{ server_confirmed: 1 }]);
    expect(await db.query('SELECT count(*) AS n FROM outbox')).toEqual([{ n: 0 }]);

    await db.run('INSERT INTO work_package (inspection_id, refreshed_at, server_confirmed, tenant_id, user_id) VALUES (?, 0, 0, ?, ?)', ['other', 'tenant-1', 'bob']);
    const foreign = await enqueue(deps, 'inspection.complete', { inspectionId: 'other' }, { account: ALICE });
    await completeRow(db, foreign, true);
    expect(await db.query("SELECT server_confirmed FROM work_package WHERE inspection_id = 'other'")).toEqual([{ server_confirmed: 0 }]);
  });
});

describe('what the waiting count shows', () => {
  it('counts pending and failed writes as waiting and orphaned ones on their own line', async () => {
    const a = await enqueue(deps, 'inspection.complete', { inspectionId: 'a' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'b' }, { account: ALICE });
    await enqueue(deps, 'inspection.complete', { inspectionId: 'c' }, { account: ALICE });
    await markFailed(db, a.idempotencyKey, 'rejected');
    expect(await countWaitingUploads(db)).toBe(3);
    expect(await countOrphanedOutbox(db)).toBe(0);
    await markOrphaned(db, 'b');
    expect(await countWaitingUploads(db)).toBe(2);
    expect(await countOrphanedOutbox(db)).toBe(1);
  });
});
