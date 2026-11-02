import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUploadBatch, type BatchState } from './batch.ts';

interface UploadEvent { name: string; id: string; payload?: { percent?: number } }

function rig(graceMs = 1000) {
  let events: (event: UploadEvent) => void = () => {};
  let count: (count: number) => void = () => {};
  const uploader = {
    onEvent: (listener: (event: UploadEvent) => void) => { events = listener; return () => {}; },
    onActiveCountChange: (listener: (count: number) => void) => { count = listener; return () => {}; },
  };
  const batch = createUploadBatch({ uploader, graceMs });
  const states: BatchState[] = [];
  const idles: Array<{ completed: number; failures: number }> = [];
  batch.onChange((state) => states.push(state));
  batch.onIdle((report) => idles.push(report));
  return { batch, states, idles, events: (e: UploadEvent) => events(e), count: (n: number) => count(n) };
}

describe('upload batch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('never moves progress backwards across waves and ends only after the idle grace', () => {
    const r = rig();
    r.count(2);
    r.events({ name: 'uploading', id: 'a', payload: { percent: 50 } });
    r.events({ name: 'uploading', id: 'b', payload: { percent: 50 } });
    r.events({ name: 'completed', id: 'a' });
    r.events({ name: 'completed', id: 'b' });
    r.count(0);
    // The next wave starts inside the grace window: still the same batch.
    vi.advanceTimersByTime(500);
    r.count(1);
    r.events({ name: 'uploading', id: 'c', payload: { percent: 5 } });
    const values = r.states.flatMap((state) => (state.kind === 'running' ? [state.progress] : []));
    for (let i = 1; i < values.length; i += 1) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    expect(r.states.some((state) => state.kind === 'none')).toBe(false);
    expect(r.idles).toEqual([]);
  });

  it('reports idle once, after the grace, with the completed and failed counts, then clears', () => {
    const r = rig();
    r.count(1);
    r.events({ name: 'completed', id: 'a' });
    r.count(0);
    vi.advanceTimersByTime(999);
    expect(r.idles).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(r.idles).toEqual([{ completed: 1, failures: 0 }]);
    expect(r.states.at(-1)).toEqual({ kind: 'none' });
    vi.advanceTimersByTime(10_000);
    expect(r.idles).toHaveLength(1);
  });

  it('reports a batch that only failed, and keeps the error state until the next batch', () => {
    const r = rig();
    r.count(1);
    r.events({ name: 'failed', id: 'a' });
    r.count(0);
    vi.advanceTimersByTime(1000);
    expect(r.idles).toEqual([{ completed: 0, failures: 1 }]);
    expect(r.states.at(-1)).toEqual({ kind: 'error-idle' });
    r.count(1);
    expect(r.states.at(-1)).toMatchObject({ kind: 'running', failed: false });
  });

  it('counts uploads that are active but have not emitted yet, so one early finisher does not pin the bar at 100%', () => {
    const r = rig();
    r.count(5);
    r.events({ name: 'uploading', id: 'a', payload: { percent: 50 } });
    r.events({ name: 'completed', id: 'a' });
    const last = r.states.at(-1);
    expect(last).toMatchObject({ kind: 'running' });
    expect((last as { progress: number }).progress).toBeLessThan(0.5);
    r.count(4);
    const after = r.states.at(-1) as { progress: number };
    expect(after.progress).toBeLessThan(0.5);
  });

  it('clears the bar and reports no idle when a start was rejected before any event', () => {
    const r = rig();
    r.count(1);
    r.count(0);
    vi.advanceTimersByTime(1000);
    expect(r.states.at(-1)).toEqual({ kind: 'none' });
    expect(r.idles).toEqual([]);
  });
});
