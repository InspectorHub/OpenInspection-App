import type { TimerPort } from '../timers';

/** Timers that only run when a test fires them; time never passes by itself. */
export interface ManualTimers extends TimerPort {
  /** Timers set and not yet fired or cleared. */
  pending(): number;
  /** The delay of every pending timer, in the order they were set. */
  delays(): number[];
  /** Fires the oldest pending timer. Throws when there is none, so a test cannot fire nothing by mistake. */
  fireNext(): void;
  /** Every delay ever requested, fired or not. */
  requested(): number[];
}

export function createManualTimers(): ManualTimers {
  const timers = new Map<number, { callback: () => void; ms: number }>();
  const requested: number[] = [];
  let next = 1;
  return {
    setTimeout: (callback, ms) => {
      const id = next++;
      timers.set(id, { callback, ms });
      requested.push(ms);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    delays: () => [...timers.values()].map((t) => t.ms),
    requested: () => [...requested],
    fireNext: () => {
      const first = timers.entries().next();
      if (first.done) throw new Error('no pending timer to fire');
      const [id, timer] = first.value;
      timers.delete(id);
      timer.callback();
    },
  };
}
