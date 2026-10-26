export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A settable clock for tests (time never moves unless the test moves it). */
export interface ManualClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function createManualClock(start = 0): ManualClock {
  let current = start;
  return {
    now: () => current,
    set: (ms) => {
      current = ms;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
