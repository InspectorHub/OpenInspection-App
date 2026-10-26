import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_ATTEMPTS } from '../../media/native-uploader';
import { accountKey } from '../../offline/outbox';
import { ALICE, at, createListWorld, NOW, type ListWorld } from '../test-support/worklist-world';
import { readWorkListSnapshot, type TitleMemo } from './model';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});

/** N packages, each with a cached title, a queued write, a failed write and two photos (one stuck for good), so every grouped query has work to do. */
async function seed(n: number): Promise<void> {
  const key = accountKey(ALICE);
  await w.db.transaction(async (tx) => {
    for (let i = 0; i < n; i += 1) {
      const id = `p${String(i).padStart(4, '0')}`;
      await tx.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, scheduled_at, server_confirmed, tenant_id, user_id, purging, quarantine_source) VALUES (?, ?, 0, ?, 1, ?, ?, 0, NULL)', [id, NOW, at(i % 3), ALICE.tenantId, ALICE.userId]);
      const body = JSON.stringify({ success: true, data: { inspection: { id, propertyAddress: `${String(i)} Elm St` } } });
      await tx.run('INSERT INTO resource_cache (account_key, key, etag, body, fetched_at, package_id) VALUES (?, ?, NULL, ?, ?, ?)', [key, `/api/inspections/${id}`, body, NOW, id]);
      await tx.run("INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, tenant_id, user_id) VALUES (?, ?, 'inspection.update', '{}', 'pending', ?, ?, ?, ?)", [`k${id}a`, i * 2 + 1, NOW, id, ALICE.tenantId, ALICE.userId]);
      await tx.run("INSERT INTO outbox (idempotency_key, seq, op, payload, state, last_error, created_at, inspection_id, tenant_id, user_id) VALUES (?, ?, 'inspection.update', '{}', 'failed', 'rejected', ?, ?, ?, ?)", [`k${id}b`, i * 2 + 2, NOW, id, ALICE.tenantId, ALICE.userId]);
      await tx.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, created_at) VALUES (?, ?, 'photo', ?, 'image/jpeg', '{}', 'pending', ?)", [`m${id}a`, id, `media/m${id}a.jpg`, NOW]);
      await tx.run("INSERT INTO media (pending_id, inspection_id, kind, path, content_type, meta, state, attempts, created_at) VALUES (?, ?, 'photo', ?, 'image/jpeg', '{}', 'failed', ?, ?)", [`m${id}b`, id, `media/m${id}b.jpg`, MAX_UPLOAD_ATTEMPTS, NOW]);
    }
  });
}

/** Every statement the snapshot sends to the database, transactions included. */
async function statementsFor(memo?: TitleMemo): Promise<{ count: number; rows: number }> {
  const spies = [vi.spyOn(w.db, 'query'), vi.spyOn(w.db, 'run'), vi.spyOn(w.db, 'execute'), vi.spyOn(w.db, 'transaction')];
  const snapshot = await readWorkListSnapshot(w.stack, NOW, memo);
  const count = spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  for (const spy of spies) spy.mockRestore();
  return { count, rows: snapshot.rows.length };
}

/**
 * The most statements one snapshot may send, whatever the number of inspections: package states, package rows, the title stamps
 * (and, only when one is new or changed, the title bodies), outbox counts, media counts, create targets, unattributable writes,
 * failed writes, failed media, the company name.
 */
const MAX_COLD = 12;
const MAX_WARM = 11;

async function measure(n: number): Promise<{ cold: number; warm: number; rows: number }> {
  w = await createListWorld();
  await seed(n);
  const memo: TitleMemo = new Map();
  const cold = await statementsFor(memo);
  const warm = await statementsFor(memo);
  return { cold: cold.count, warm: warm.count, rows: cold.rows };
}

describe('the work list snapshot sends a fixed number of statements', () => {
  it('10 inspections and 500 inspections cost the same, on a cold read and on a warm one, and a small number', async () => {
    const small = await measure(10);
    const large = await measure(500);
    expect([small.rows, large.rows]).toEqual([10, 500]);
    expect(large.cold).toBe(small.cold);
    expect(large.warm).toBe(small.warm);
    expect(small.cold).toBeLessThanOrEqual(MAX_COLD);
    expect(small.warm).toBeLessThanOrEqual(MAX_WARM);
  }, 60_000);

  it('the same rows come back whatever the statements are: titles, counts and order for a handful of inspections', async () => {
    w = await createListWorld();
    await seed(4);
    const snapshot = await readWorkListSnapshot(w.stack, NOW);
    expect(snapshot.rows.map((r) => [r.id, r.title, r.waiting, r.needAttention])).toEqual([
      ['p0000', '0 Elm St', 2, 2],
      ['p0003', '3 Elm St', 2, 2],
      ['p0001', '1 Elm St', 2, 2],
      ['p0002', '2 Elm St', 2, 2],
    ]);
  });
});
