import { describe, expect, it, vi } from 'vitest';
import type { InspectionRefresh } from '../offline/work-package';
import { createRefreshAfterReplay } from './refresh-after-replay';

function setup(answers: InspectionRefresh[], stoppedAfter = Infinity) {
  const calls: string[] = [];
  const queue = [...answers];
  let idles = 0;
  const hook = createRefreshAfterReplay({
    refresher: {
      refreshInspection: (id) => {
        calls.push(id);
        return Promise.resolve(queue.shift() ?? { kind: 'refreshed' });
      },
    },
    settle: () => {
      idles += 1;
      return Promise.resolve();
    },
    isStopped: () => calls.length >= stoppedAfter,
  });
  return { hook, calls, idles: () => idles };
}

describe('refresh after replay', () => {
  it('refreshes each named inspection once, in order, and nothing else', async () => {
    const { hook, calls } = setup([]);
    await hook(['a', 'b']);
    expect(calls).toEqual(['a', 'b']);
  });

  it('control: no names, no refresh', async () => {
    const { hook, calls } = setup([]);
    await hook([]);
    expect(calls).toEqual([]);
  });

  it('when another flow holds the lease it waits for it and asks again, and gives up after a few asks', async () => {
    const once = setup([{ kind: 'busy' }]);
    await once.hook(['a']);
    expect(once.calls).toEqual(['a', 'a']);
    expect(once.idles()).toBe(1);
    const always = setup(Array.from({ length: 10 }, () => ({ kind: 'busy' }) as const));
    await always.hook(['a']);
    expect(always.calls).toHaveLength(4);
  });

  it('stops asking once the stack is stopped', async () => {
    const { hook, calls } = setup([], 1);
    await hook(['a', 'b', 'c']);
    expect(calls).toEqual(['a']);
  });

  it('a refresh that throws does not stop the others and does not reject', async () => {
    const refreshInspection = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue({ kind: 'refreshed' });
    const hook = createRefreshAfterReplay({ refresher: { refreshInspection }, settle: () => Promise.resolve(), isStopped: () => false });
    await expect(hook(['a', 'b'])).resolves.toBeUndefined();
    expect(refreshInspection).toHaveBeenCalledTimes(2);
  });
});
