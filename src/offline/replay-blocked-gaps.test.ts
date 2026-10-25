import { describe, expect, it } from 'vitest';
import { readOutboxRow } from './outbox';
import { createReplayWorld } from './test-support/replay-world';

describe('a block that begins while the access token is being fetched', () => {
  it('leaves the row pending, records nothing, reports no error and does not crash the run', async () => {
    const w = await createReplayWorld();
    w.server.inspections.set('a', { cancelled: false });
    const row = await w.queue('inspection.update', { inspectionId: 'a', changes: { sqft: 10 } });
    // The first answer is the drain's own check, the second the one made right before the request.
    const answers = [false, true];
    const replayer = w.another({ isBlocked: () => Promise.resolve(answers.shift() ?? true) });
    const result = await replayer.replay();
    expect(result).toEqual({ sent: 0, failed: 0, waiting: 0, halted: null, leaseBusy: false });
    expect(w.errors).toEqual([]);
    expect(w.server.requests).toEqual([]);
    expect(w.reconciles).toEqual([]);
    expect(await readOutboxRow(w.db, row.idempotencyKey)).toMatchObject({ state: 'pending', attempts: 0, nextAt: null, lastError: null });
  });

  it('control: when the second answer is "free" the same write is sent', async () => {
    const w = await createReplayWorld();
    w.server.inspections.set('a', { cancelled: false });
    await w.queue('inspection.update', { inspectionId: 'a', changes: { sqft: 10 } });
    const replayer = w.another({ isBlocked: () => Promise.resolve(false) });
    expect(await replayer.replay()).toMatchObject({ sent: 1 });
    expect(w.errors).toEqual([]);
  });
});
