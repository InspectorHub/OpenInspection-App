import type { AppStatePort, Scheduler } from '../lock-monitor';

/** A scheduler that only runs its callbacks when a test calls `tick()`. */
export interface FakeScheduler extends Scheduler {
  active(): number;
  tick(): void;
  lastMs(): number | null;
}

export function fakeScheduler(): FakeScheduler {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  let ms: number | null = null;
  return {
    setInterval: (fn, interval) => {
      ms = interval;
      const id = next++;
      callbacks.set(id, fn);
      return id;
    },
    clearInterval: (handle) => {
      callbacks.delete(handle as number);
    },
    active: () => callbacks.size,
    tick: () => {
      for (const fn of [...callbacks.values()]) fn();
    },
    lastMs: () => ms,
  };
}

export interface FakeAppState extends AppStatePort {
  emit(active: boolean): void;
  listeners(): number;
}

export function fakeAppState(): FakeAppState {
  const set = new Set<(active: boolean) => void>();
  return {
    onChange: (listener) => {
      set.add(listener);
      return () => set.delete(listener);
    },
    emit: (active) => {
      for (const l of [...set]) l(active);
    },
    listeners: () => set.size,
  };
}
