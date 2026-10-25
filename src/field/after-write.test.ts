import { describe, expect, it } from 'vitest';
import type { InspectionRefresh } from '../offline/work-package';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { createAfterWrite } from './after-write';

function setup(answers: (InspectionRefresh | 'hang' | Error)[]) {
  const timers = createManualTimers();
  const calls: string[] = [];
  let settles = 0;
  const queue = [...answers];
  const afterWrite = createAfterWrite({
    refresher: {
      refreshInspection: (id) => {
        calls.push(id);
        const next = queue.shift() ?? { kind: 'refreshed' as const };
        if (next === 'hang') return new Promise<InspectionRefresh>(() => undefined);
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
    settle: () => {
      settles += 1;
      return Promise.resolve();
    },
    timers,
    timeoutMs: 8000,
  });
  return { afterWrite, calls, timers, settles: () => settles };
}

describe('after write', () => {
  it('true when that inspection was refreshed, and the timer it set is cleared', async () => {
    const { afterWrite, calls, timers } = setup([{ kind: 'refreshed' }]);
    expect(await afterWrite('i1')).toBe(true);
    expect(calls).toEqual(['i1']);
    expect(timers.pending()).toBe(0);
    expect(timers.requested()).toEqual([8000]);
  });

  it.each([{ kind: 'skipped' }, { kind: 'failed' }, { kind: 'halted', reason: 'offline' }] as const)('false when the refresh answers %j: the cache was not changed', async (answer) => {
    const { afterWrite } = setup([answer]);
    expect(await afterWrite('i1')).toBe(false);
  });

  it('false when the refresh rejects', async () => {
    const { afterWrite } = setup([new Error('x')]);
    expect(await afterWrite('i1')).toBe(false);
  });

  it('false when the refresh takes longer than the bound, and the caller is not kept waiting', async () => {
    const { afterWrite, timers } = setup(['hang']);
    const pending = afterWrite('i1');
    await Promise.resolve();
    timers.fireWithDelay(8000);
    expect(await pending).toBe(false);
  });

  it('when another flow holds the lease it waits for the others and asks again; control: it gives up after a few asks', async () => {
    const once = setup([{ kind: 'busy' }, { kind: 'refreshed' }]);
    expect(await once.afterWrite('i1')).toBe(true);
    expect(once.calls).toEqual(['i1', 'i1']);
    expect(once.settles()).toBe(1);
    const always = setup(Array.from({ length: 9 }, () => ({ kind: 'busy' }) as const));
    expect(await always.afterWrite('i1')).toBe(false);
    expect(always.calls).toHaveLength(3);
  });
});
