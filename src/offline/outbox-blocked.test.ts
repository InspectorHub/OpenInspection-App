import { beforeEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../platform/clock';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { enqueue, listOutbox, OutboxError, type Account, type OutboxDeps } from './outbox';

const ALICE: Account = { tenantId: 'tenant-1', userId: 'alice' };
const UPDATE = { inspectionId: 'insp-1', changes: { sqft: 10 } };

let db: Db;
let deps: OutboxDeps;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
  let n = 0;
  deps = { db, clock: createManualClock(5000), newId: () => `id-${String((n += 1))}` };
});

async function pkg(purging: number, quarantine: string | null): Promise<void> {
  await db.run('INSERT INTO work_package (inspection_id, refreshed_at, tenant_id, user_id, purging, quarantine_source) VALUES (?, 1, ?, ?, ?, ?)', ['insp-1', ALICE.tenantId, ALICE.userId, purging, quarantine]);
}

async function refused(): Promise<unknown> {
  return enqueue(deps, 'inspection.update', UPDATE, { account: ALICE }).catch((error: unknown) => error);
}

describe('enqueue refuses a write for a blocked inspection', () => {
  it('a tombstoned inspection: refused with the blocked code, nothing stored, no sequence number used', async () => {
    await pkg(1, null);
    const error = await refused();
    expect(error).toBeInstanceOf(OutboxError);
    expect(error).toMatchObject({ code: 'blocked' });
    expect(await listOutbox(db)).toEqual([]);
    expect(await db.query("SELECT value FROM device_state WHERE key = 'outbox_seq'")).toEqual([]);
  });

  it('a quarantined inspection is refused the same way', async () => {
    await pkg(0, 'reconcile_missing');
    expect(await refused()).toMatchObject({ code: 'blocked' });
    expect(await listOutbox(db)).toEqual([]);
  });

  it('the user-confirmed tombstone (2) is refused too', async () => {
    await pkg(2, null);
    expect(await refused()).toMatchObject({ code: 'blocked' });
  });

  it('control: the identical write for the identical package without either flag is stored', async () => {
    await pkg(0, null);
    const row = await enqueue(deps, 'inspection.update', UPDATE, { account: ALICE });
    expect(row.state).toBe('pending');
    expect(await listOutbox(db)).toHaveLength(1);
  });

  it('control: an inspection with no package row yet is not blocked', async () => {
    const row = await enqueue(deps, 'inspection.update', UPDATE, { account: ALICE });
    expect(row.inspectionId).toBe('insp-1');
  });

  it('another inspection of the same account is not affected', async () => {
    await pkg(1, null);
    const row = await enqueue(deps, 'inspection.update', { inspectionId: 'insp-2', changes: { sqft: 1 } }, { account: ALICE });
    expect(row.inspectionId).toBe('insp-2');
  });
});
