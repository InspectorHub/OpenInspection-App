import { describe, expect, it } from 'vitest';
import { readOutboxRow } from './outbox';
import { createReplayWorld, type ReplayWorld } from './test-support/replay-world';

const COMPLETE = (id: string) => ({ inspectionId: id });
const UPDATE = (id: string) => ({ inspectionId: id, changes: { sqft: 10 } });

function seed(w: ReplayWorld, ...ids: string[]): void {
  for (const id of ids) w.server.inspections.set(id, { cancelled: false });
}

async function snapshot(w: ReplayWorld, key: string) {
  const row = await readOutboxRow(w.db, key);
  return row === null ? null : { state: row.state, lastError: row.lastError, attempts: row.attempts, nextAt: row.nextAt };
}

describe('the replayer leaves the writes of a blocked inspection alone', () => {
  it('sends nothing for it, records nothing on its rows, does not halt, and still sends the others', async () => {
    const w = await createReplayWorld();
    seed(w, 'held', 'free');
    const held = await w.queue('inspection.update', UPDATE('held'));
    const free = await w.queue('inspection.update', UPDATE('free'));
    const before = await snapshot(w, held.idempotencyKey);
    const blocked = new Set(['held']);
    const replayer = w.another({ isBlocked: (id) => Promise.resolve(blocked.has(id)) });
    const result = await replayer.replay();
    expect(result).toEqual({ sent: 1, failed: 0, waiting: 0, halted: null, leaseBusy: false });
    expect(w.server.requests.map((r) => new URL(r.url).pathname)).toEqual(['/api/inspections/free']);
    expect(await snapshot(w, held.idempotencyKey)).toEqual(before);
    expect(await snapshot(w, held.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0, nextAt: null, lastError: null });
    expect(await readOutboxRow(w.db, free.idempotencyKey)).toBeNull();
    expect(w.halts).toEqual([]);
    expect(w.reconciles).toEqual([]);
    expect(w.errors).toEqual([]);
  });

  it('control: the same two writes with nothing blocked are both sent', async () => {
    const w = await createReplayWorld();
    seed(w, 'held', 'free');
    await w.queue('inspection.update', UPDATE('held'));
    await w.queue('inspection.update', UPDATE('free'));
    const replayer = w.another({ isBlocked: () => Promise.resolve(false) });
    expect(await replayer.replay()).toMatchObject({ sent: 2 });
    expect(await w.rows()).toEqual([]);
  });

  it('a later write of the blocked inspection waits too, and the block lifting sends both in order', async () => {
    const w = await createReplayWorld();
    seed(w, 'held');
    await w.queue('inspection.update', UPDATE('held'));
    await w.queue('inspection.complete', COMPLETE('held'));
    let blocked = true;
    const replayer = w.another({ isBlocked: () => Promise.resolve(blocked) });
    expect(await replayer.replay()).toMatchObject({ sent: 0, failed: 0, waiting: 0, halted: null });
    expect(w.server.requests).toEqual([]);
    expect((await w.rows()).map((r) => r.state)).toEqual(['pending', 'pending']);
    blocked = false;
    expect(await replayer.replay()).toMatchObject({ sent: 2 });
    expect(w.server.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['PATCH /api/inspections/held', 'POST /api/inspections/held/complete']);
  });

  it('fails closed: a guard that rejects sends nothing and fails nothing', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.update', UPDATE('a'));
    const replayer = w.another({ isBlocked: () => Promise.reject(new Error('unreadable')) });
    expect(await replayer.replay()).toMatchObject({ sent: 0, failed: 0, halted: null });
    expect(w.server.requests).toEqual([]);
    expect(await snapshot(w, row.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('a tombstone that lands while the token is being fetched stops the request before it is sent', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    const row = await w.queue('inspection.update', UPDATE('a'));
    const answers = [false, true];
    const replayer = w.another({ isBlocked: () => Promise.resolve(answers.shift() ?? true) });
    const result = await replayer.replay();
    expect(w.server.requests).toEqual([]);
    expect(result).toMatchObject({ sent: 0, failed: 0, waiting: 0, halted: null });
    expect(await snapshot(w, row.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('asks the guard for the inspection of the row and for nothing else', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.update', UPDATE('a'));
    const asked: string[] = [];
    const replayer = w.another({
      isBlocked: (id) => {
        asked.push(id);
        return Promise.resolve(true);
      },
    });
    await replayer.replay();
    expect(asked).toEqual(['a']);
  });

  it('control: a replayer whose guard says free sends everything', async () => {
    const w = await createReplayWorld();
    seed(w, 'a');
    await w.queue('inspection.update', UPDATE('a'));
    expect(await w.replayer.replay()).toMatchObject({ sent: 1 });
  });
});
