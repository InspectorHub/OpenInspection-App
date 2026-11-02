import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createPowerBridge, createPowerSaveGuard } from './power.ts';

describe('desktop power lifecycle', () => {
  it('aborts uploads on suspend and maps resume and unlock, but not lock, to active state', () => {
    const monitor = new EventEmitter();
    const abortAll = vi.fn();
    const emitActive = vi.fn();
    const dispose = createPowerBridge({ powerMonitor: monitor, uploader: { abortAll }, emitActive });

    monitor.emit('suspend');
    monitor.emit('resume');
    monitor.emit('lock-screen');
    monitor.emit('unlock-screen');

    expect(abortAll).toHaveBeenCalledExactlyOnceWith('suspend');
    expect(emitActive.mock.calls).toEqual([[false], [true], [true]]);
    dispose();
    monitor.emit('resume');
    expect(emitActive).toHaveBeenCalledTimes(3);
  });

  it('holds one power-save blocker from the first upload until the last drains, then disposes safely', () => {
    const listeners = new Set<(count: number) => void>();
    const uploader = { onActiveCountChange: vi.fn((listener: (count: number) => void) => { listeners.add(listener); return () => listeners.delete(listener); }) };
    const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
    const dispose = createPowerSaveGuard({ blocker, uploader });
    const emit = (count: number) => { for (const listener of listeners) listener(count); };

    emit(1); emit(2); emit(0); emit(0); emit(3); emit(1); emit(0);
    expect(blocker.start.mock.calls).toEqual([['prevent-app-suspension'], ['prevent-app-suspension']]);
    expect(blocker.stop.mock.calls).toEqual([[7], [7]]);
    dispose();
    dispose();
    emit(1);
    expect(listeners.size).toBe(0);
    expect(blocker.start).toHaveBeenCalledTimes(2);
  });
});
