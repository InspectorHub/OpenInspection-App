import { describe, expect, it, vi } from 'vitest';
import { createTaskbarProgress } from './taskbar.ts';

interface UploadEvent { name: string; id: string; payload?: { percent?: number } }

describe('taskbar upload progress', () => {
  it('averages active upload progress and clears on drain or disposal', () => {
    let events: ((event: UploadEvent) => void) | undefined;
    let count: ((count: number) => void) | undefined;
    const offEvent = vi.fn(() => { events = undefined; });
    const offCount = vi.fn(() => { count = undefined; });
    const uploader = { onEvent: vi.fn((listener: (event: UploadEvent) => void) => { events = listener; return offEvent; }), onActiveCountChange: vi.fn((listener: (count: number) => void) => { count = listener; return offCount; }) };
    const win = { setProgressBar: vi.fn() };
    const dispose = createTaskbarProgress({ win, uploader });

    count?.(2);
    events?.({ name: 'uploading', id: 'a', payload: { percent: 40 } });
    events?.({ name: 'uploading', id: 'b', payload: { percent: 80 } });
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0.6, { mode: 'normal' });
    events?.({ name: 'failed', id: 'a' });
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0.4, { mode: 'error' });
    count?.(1);
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0.8, { mode: 'error' });
    count?.(0);
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'error' });
    count?.(1);
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'normal' });
    dispose(); dispose();
    expect(offEvent).toHaveBeenCalledOnce();
    expect(offCount).toHaveBeenCalledOnce();
  });

  it('keeps a single failed upload visibly in error mode after drain until the next batch', () => {
    let events: ((event: UploadEvent) => void) | undefined;
    let count: ((count: number) => void) | undefined;
    const uploader = {
      onEvent: (listener: (event: UploadEvent) => void) => { events = listener; return () => {}; },
      onActiveCountChange: (listener: (count: number) => void) => { count = listener; return () => {}; },
    };
    const win = { setProgressBar: vi.fn() };
    createTaskbarProgress({ win, uploader });

    count?.(1);
    events?.({ name: 'failed', id: 'only' });
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'error' });
    count?.(0);
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'error' });
    count?.(1);
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'normal' });
  });

  it('retains the error indication when concurrent uploads fail as the batch drains', () => {
    let events: ((event: UploadEvent) => void) | undefined;
    let count: ((count: number) => void) | undefined;
    const uploader = {
      onEvent: (listener: (event: UploadEvent) => void) => { events = listener; return () => {}; },
      onActiveCountChange: (listener: (count: number) => void) => { count = listener; return () => {}; },
    };
    const win = { setProgressBar: vi.fn() };
    createTaskbarProgress({ win, uploader });

    count?.(2);
    events?.({ name: 'failed', id: 'first' });
    count?.(1);
    events?.({ name: 'failed', id: 'second' });
    count?.(0);

    expect(win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'error' });
    count?.(1);
    expect(win.setProgressBar).toHaveBeenLastCalledWith(0, { mode: 'normal' });
  });
});
