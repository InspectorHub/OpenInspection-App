import { describe, expect, it } from 'vitest';
import { createDataPackagePowerGuard, type PowerBlockerLike, type DataPackagePowerMonitor } from './power';

function harness() {
  const calls: string[] = [];
  const blocker: PowerBlockerLike = {
    start: () => { calls.push('start'); return 7; },
    stop: (id) => { calls.push(`stop:${id}`); },
  };
  const listeners: Array<[string, () => void]> = [];
  const monitor: DataPackagePowerMonitor = {
    on: (event, listener) => { listeners.push([event, listener]); calls.push(`on:${event}`); },
    removeListener: (event) => { calls.push(`off:${event}`); },
  };
  const events: string[] = [];
  const guard = createDataPackagePowerGuard({
    blocker,
    powerMonitor: monitor,
    onSuspend: () => events.push('suspend'),
    onResume: () => events.push('resume'),
  });
  return { guard, calls, listeners, events };
}

describe('data-package power guard', () => {
  it('holds a single blocker across overlapping acquisitions and releases it at zero', () => {
    const { guard, calls } = harness();
    expect(guard.activeCount()).toBe(0);
    guard.acquire();
    guard.acquire();
    expect(guard.activeCount()).toBe(2);
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
    guard.release();
    expect(calls.filter((c) => c === 'start')).toHaveLength(1);
    guard.release();
    expect(guard.activeCount()).toBe(0);
    expect(calls).toContain('stop:7');
  });

  it('never releases below zero', () => {
    const { guard, calls } = harness();
    guard.release();
    expect(guard.activeCount()).toBe(0);
    expect(calls.filter((c) => c === 'start')).toHaveLength(0);
    expect(calls.filter((c) => c.startsWith('stop'))).toHaveLength(0);
  });

  it('forwards suspend/resume so a job can pause and continue', () => {
    const { listeners, events } = harness();
    const suspend = listeners.find(([e]) => e === 'suspend')?.[1];
    const resume = listeners.find(([e]) => e === 'resume')?.[1];
    suspend?.();
    resume?.();
    expect(events).toEqual(['suspend', 'resume']);
  });

  it('dispose clears the blocker and listeners exactly once', () => {
    const { guard, calls } = harness();
    guard.acquire();
    guard.dispose();
    const afterFirst = [...calls];
    guard.dispose();
    expect(calls).toEqual(afterFirst);
    expect(calls.filter((c) => c.startsWith('stop'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('off:'))).toHaveLength(4);
  });
});
