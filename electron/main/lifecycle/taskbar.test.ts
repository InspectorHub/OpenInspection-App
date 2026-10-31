import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUploadBatch } from './batch.ts';
import { createTaskbarProgress } from './taskbar.ts';

interface UploadEvent { name: string; id: string; payload?: { percent?: number } }

function rig() {
  let events: (event: UploadEvent) => void = () => {};
  let count: (count: number) => void = () => {};
  const uploader = {
    onEvent: (listener: (event: UploadEvent) => void) => { events = listener; return () => {}; },
    onActiveCountChange: (listener: (count: number) => void) => { count = listener; return () => {}; },
  };
  const batch = createUploadBatch({ uploader, graceMs: 1000 });
  const win = { setProgressBar: vi.fn() };
  const dispose = createTaskbarProgress({ win, batch });
  return { win, dispose, batch, events: (e: UploadEvent) => events(e), count: (n: number) => count(n) };
}

describe('taskbar upload progress', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('climbs monotonically through a 50-item batch uploaded in waves of 3, and clears only after the last grace', () => {
    const r = rig();
    for (let wave = 0; wave < 17; wave += 1) {
      const ids = [0, 1, 2].map((n) => `w${String(wave)}-${String(n)}`).slice(0, wave === 16 ? 2 : 3);
      r.count(ids.length);
      for (const id of ids) r.events({ name: 'uploading', id, payload: { percent: 10 } });
      for (const id of ids) r.events({ name: 'uploading', id, payload: { percent: 70 } });
      for (const id of ids) r.events({ name: 'completed', id });
      r.count(0);
      vi.advanceTimersByTime(200);
    }
    const values = r.win.setProgressBar.mock.calls.map((call) => call[0] as number).filter((value) => value >= 0);
    const drops = values.filter((value, index) => index > 0 && value < values[index - 1]! - 1e-9);
    expect(drops).toEqual([]);
    expect(r.win.setProgressBar.mock.calls.some((call) => call[0] === -1), 'not cleared between waves').toBe(false);
    vi.advanceTimersByTime(1000);
    expect(r.win.setProgressBar).toHaveBeenLastCalledWith(-1, { mode: 'none' });
  });

  it('keeps the high-water mark when a new item enlarges the total', () => {
    const r = rig();
    r.count(1);
    r.events({ name: 'uploading', id: 'a', payload: { percent: 90 } });
    const before = r.win.setProgressBar.mock.calls.at(-1)?.[0] as number;
    r.count(2);
    r.events({ name: 'uploading', id: 'b', payload: { percent: 1 } });
    expect(r.win.setProgressBar.mock.calls.at(-1)?.[0] as number).toBeGreaterThanOrEqual(before);
  });

  it('shows error mode for a failed item, keeps it after the batch ends until the next batch, and detaches on disposal', () => {
    const r = rig();
    r.count(1);
    r.events({ name: 'failed', id: 'only' });
    expect(r.win.setProgressBar).toHaveBeenLastCalledWith(1, { mode: 'error' });
    r.count(0);
    vi.advanceTimersByTime(1000);
    expect(r.win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'error' });
    r.count(1);
    expect(r.win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'normal' });
    r.dispose(); r.dispose();
    expect(r.win.setProgressBar).toHaveBeenLastCalledWith(-1, { mode: 'none' });
    const calls = r.win.setProgressBar.mock.calls.length;
    r.events({ name: 'uploading', id: 'x', payload: { percent: 50 } });
    expect(r.win.setProgressBar.mock.calls.length).toBe(calls);
  });
});
