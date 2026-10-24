import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../platform/db';
import { createSqlJsDb } from '../platform/db-sqljs';
import { migrate } from '../platform/schema';
import { HEADS_SQL, WAITING_SQL } from './replay-queries';

const NOW = 1_000_000;
const FAR = NOW + 10_000_000;

let db: Db;

beforeEach(async () => {
  db = await createSqlJsDb();
  await migrate(db, 0);
});

async function insert(rows: { seq: number; inspection: string | null; nextAt: number | null; state?: string; user?: string }[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const r of rows) {
      await tx.run(
        `INSERT INTO outbox (idempotency_key, seq, op, payload, state, created_at, inspection_id, registry_version, tenant_id, user_id, attempts, next_at)
         VALUES (?, ?, 'x', '{}', ?, 1, ?, 1, 't1', ?, 0, ?)`,
        [`k${String(r.seq)}`, r.seq, r.state ?? 'pending', r.inspection, r.user ?? 'u1', r.nextAt],
      );
    }
  });
}

async function plan(sql: string, params: unknown[]): Promise<string> {
  return (await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params as never[])).map((p) => p.detail).join(' | ');
}

const HEAD_PARAMS = ['t1', 'u1', NOW, FAR, 200];
const WAIT_PARAMS = ['t1', 'u1', NOW, FAR];

async function heads(): Promise<string[]> {
  return (await db.query<{ idempotency_key: string }>(HEADS_SQL, HEAD_PARAMS as never[])).map((r) => r.idempotency_key);
}

describe('replay head queries: semantics', () => {
  it('treats rows without an inspection as one line of their own and each inspection as another', async () => {
    await insert([
      { seq: 1, inspection: null, nextAt: null },
      { seq: 2, inspection: 'a', nextAt: null },
      { seq: 3, inspection: null, nextAt: null },
      { seq: 4, inspection: 'a', nextAt: null },
      { seq: 5, inspection: 'b', nextAt: null },
    ]);
    expect(await heads()).toEqual(['k1', 'k2', 'k5']);
  });

  it('a waiting head holds back the later rows of its own line only', async () => {
    await insert([
      { seq: 1, inspection: null, nextAt: NOW + 5_000 },
      { seq: 2, inspection: null, nextAt: null },
      { seq: 3, inspection: 'a', nextAt: null },
    ]);
    expect(await heads()).toEqual(['k3']);
    const rows = await db.query<{ at: number | null }>(WAITING_SQL, WAIT_PARAMS as never[]);
    expect(rows[0]?.at).toBe(NOW + 5_000);
  });

  it('a later row of a line is not the head even when its next_at is the earliest', async () => {
    await insert([
      { seq: 1, inspection: 'a', nextAt: NOW + 9_000 },
      { seq: 2, inspection: 'a', nextAt: NOW + 1_000 },
    ]);
    const rows = await db.query<{ at: number | null }>(WAITING_SQL, WAIT_PARAMS as never[]);
    expect(rows[0]?.at).toBe(NOW + 9_000);
  });

  it('another account never sets the head of this account (positive control: its own rows are found)', async () => {
    await insert([
      { seq: 1, inspection: 'a', nextAt: null, user: 'u2' },
      { seq: 2, inspection: 'a', nextAt: null },
    ]);
    expect(await heads()).toEqual(['k2']);
  });
});

describe('replay head queries: the plan uses the line index', () => {
  it('the heads query looks the head up through idx_outbox_line and never scans the outer table for it', async () => {
    const detail = await plan(HEADS_SQL, HEAD_PARAMS);
    expect(detail).toContain('idx_outbox_line');
    expect(detail).not.toContain('SCAN i');
    expect(detail).not.toMatch(/SEARCH i USING INDEX idx_outbox_seq/);
  });

  it('the waiting query looks the head up through idx_outbox_line', async () => {
    const detail = await plan(WAITING_SQL, WAIT_PARAMS);
    expect(detail).toContain('idx_outbox_line');
    expect(detail).not.toMatch(/SEARCH i USING INDEX idx_outbox_seq/);
  });
});

describe('replay head queries: scale', () => {
  it('3000 rows in 300 lines answer both queries well inside a generous bound, three times in a row', async () => {
    const rows = Array.from({ length: 3000 }, (_, n) => ({ seq: n + 1, inspection: n % 10 === 0 ? null : `i${String(n % 300)}`, nextAt: n % 7 === 0 ? NOW + 1_000 + n : null }));
    await insert(rows);
    const times: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const start = performance.now();
      const found = await heads();
      await db.query(WAITING_SQL, WAIT_PARAMS as never[]);
      times.push(performance.now() - start);
      expect(found.length).toBeGreaterThan(0);
    }
    expect(Math.max(...times), times.map((t) => t.toFixed(0)).join(',')).toBeLessThan(150);
  });
});
