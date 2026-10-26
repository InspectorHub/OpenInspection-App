import { beforeEach, describe, expect, it } from 'vitest';
import { enqueue } from '../offline/outbox';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { hasQueuedWrites } from './queued-writes';
import { ALICE, BOB } from './test-support/seed-package';

let db: Db;
const clock = createManualClock(1);
const queue = (op: string, input: unknown, account = ALICE) => enqueue({ db, clock }, op, input, { account });

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

describe('hasQueuedWrites', () => {
  it('is false with nothing queued, true with a pending row of any op', async () => {
    expect(await hasQueuedWrites(db, ALICE, 'i1')).toBe(false);
    await queue('inspection.complete', { inspectionId: 'i1' });
    expect(await hasQueuedWrites(db, ALICE, 'i1')).toBe(true);
  });

  it('a failed row counts: it stops the line until a person acts', async () => {
    const row = await queue('inspection.update', { inspectionId: 'i1', changes: { sqft: 1 } });
    await db.run("UPDATE outbox SET state = 'failed', last_error = 'rejected' WHERE idempotency_key = ?", [row.idempotencyKey]);
    expect(await hasQueuedWrites(db, ALICE, 'i1')).toBe(true);
  });

  it('another inspection, another account and an orphaned row do not count', async () => {
    await queue('inspection.complete', { inspectionId: 'other' });
    await queue('inspection.complete', { inspectionId: 'i1' }, BOB);
    const orphan = await queue('inspection.complete', { inspectionId: 'i1' });
    await db.run("UPDATE outbox SET state = 'orphaned', last_error = 'target_gone' WHERE idempotency_key = ?", [orphan.idempotencyKey]);
    expect(await hasQueuedWrites(db, ALICE, 'i1')).toBe(false);
  });

  it('answers true when it cannot tell: a read that fails must not let a write past the queue', async () => {
    const broken: Db = { ...db, query: () => Promise.reject(new Error('db down')) };
    expect(await hasQueuedWrites(broken, ALICE, 'i1')).toBe(true);
  });
});
