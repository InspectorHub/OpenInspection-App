import { describe, expect, it } from 'vitest';
import { ALICE, BOB, createReplayWorld, type ReplayWorld } from './test-support/replay-world';

function seed(w: ReplayWorld, ...ids: string[]): void {
  for (const id of ids) w.server.inspections.set(id, { cancelled: false });
}

describe('onInspectionsSent', () => {
  it('names each inspection that had a row sent, once per run, however many rows it had', async () => {
    const w = await createReplayWorld();
    const calls: string[][] = [];
    const replayer = w.another({ onInspectionsSent: (ids) => calls.push([...ids]) });
    seed(w, 'a', 'b');
    await w.queue('inspection.update', { inspectionId: 'a', changes: { sqft: 10 } });
    await w.queue('inspection.complete', { inspectionId: 'a' });
    await w.queue('inspection.complete', { inspectionId: 'b' });
    await replayer.replay();
    expect(calls).toEqual([['a', 'b']]);
  });

  it('does not name an inspection whose row was not sent (control: the one that was is named)', async () => {
    const w = await createReplayWorld();
    const calls: string[][] = [];
    const replayer = w.another({ onInspectionsSent: (ids) => calls.push([...ids]) });
    seed(w, 'a');
    await w.queue('inspection.complete', { inspectionId: 'a' });
    await w.queue('inspection.complete', { inspectionId: 'gone' });
    await replayer.replay();
    expect(calls).toEqual([['a']]);
  });

  it('is not called when nothing was sent', async () => {
    const w = await createReplayWorld();
    const calls: string[][] = [];
    const replayer = w.another({ onInspectionsSent: (ids) => calls.push([...ids]) });
    await w.queue('inspection.complete', { inspectionId: 'gone' });
    await replayer.replay();
    await w.another({ onInspectionsSent: (ids) => calls.push([...ids]) }).replay();
    expect(calls).toEqual([]);
  });

  it('never names the rows of another account', async () => {
    const w = await createReplayWorld();
    const calls: string[][] = [];
    const replayer = w.another({ onInspectionsSent: (ids) => calls.push([...ids]) });
    seed(w, 'mine', 'theirs');
    await w.queue('inspection.complete', { inspectionId: 'mine' }, ALICE);
    await w.queue('inspection.complete', { inspectionId: 'theirs' }, BOB);
    await replayer.replay();
    expect(calls).toEqual([['mine']]);
  });

  it('a hook that throws changes nothing about the run', async () => {
    const w = await createReplayWorld();
    const replayer = w.another({
      onInspectionsSent: () => {
        throw new Error('boom');
      },
    });
    seed(w, 'a');
    await w.queue('inspection.complete', { inspectionId: 'a' });
    expect(await replayer.replay()).toMatchObject({ sent: 1, halted: null });
    expect(await w.rows()).toEqual([]);
  });
});
