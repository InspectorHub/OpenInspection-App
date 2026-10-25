import { describe, expect, it, vi } from 'vitest';
import { ALICE } from '../offline/test-support/replay-world';
import { createStackWorld } from './test-support/stack-world';

async function world() {
  const w = await createStackWorld();
  for (const id of ['insp-1', 'insp-2']) {
    w.pkg.inspections.set(id, { date: '2026-01-01T10:00:00.000Z', status: 'scheduled', inspectorId: ALICE.userId });
    await w.replay.db.run('INSERT INTO work_package (inspection_id, refreshed_at, pinned, server_confirmed, tenant_id, user_id) VALUES (?, 1, 0, 1, ?, ?)', [id, ALICE.tenantId, ALICE.userId]);
  }
  return w;
}

describe('the stack refreshes an inspection after its queued write was sent', () => {
  it('refreshes the inspection that had a row sent, and no other', async () => {
    const w = await world();
    const stack = w.make();
    const spy = vi.spyOn(stack.refresher, 'refreshInspection');
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(spy).not.toHaveBeenCalled();
    await stack.enqueue('inspection.complete', { inspectionId: 'insp-1' });
    await stack.idle();
    expect(new Set(spy.mock.calls.map((call) => call[0]))).toEqual(new Set(['insp-1']));
    const last = spy.mock.results[spy.mock.results.length - 1];
    expect(await last?.value).toEqual({ kind: 'refreshed' });
    await stack.stop();
  });

  it('a write sent by the first replay of the start sequence is covered by the full refresh that follows it, not refreshed twice', async () => {
    const w = await world();
    const stack = w.make();
    const spy = vi.spyOn(stack.refresher, 'refreshInspection');
    await stack.enqueue('inspection.complete', { inspectionId: 'insp-1' });
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(spy).not.toHaveBeenCalled();
    await stack.stop();
  });

  it('control: with nothing queued nothing is refreshed this way', async () => {
    const w = await world();
    const stack = w.make();
    const spy = vi.spyOn(stack.refresher, 'refreshInspection');
    stack.start();
    await stack.settled();
    await stack.idle();
    expect(spy).not.toHaveBeenCalled();
    await stack.stop();
  });
});
