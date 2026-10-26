/** The fixed names of the durations the app measures about itself. Nothing else is ever recorded. */
export type TimingCode = 'snapshot_ms' | 'launch_wait_ms';

export interface TimingSummary {
  code: TimingCode;
  /** The first duration recorded under this code in this process: the cold one. */
  first: number;
  /** The latest few, oldest first. */
  last: readonly number[];
}

export interface TimingRing {
  /** Records one duration in whole milliseconds. A value that is not a finite, non-negative number is ignored. */
  record(code: TimingCode, ms: number): void;
  /** What was recorded, per code, in the order the codes were first seen. A copy. */
  summary(): readonly TimingSummary[];
}

/** How many of the latest durations each code keeps (the first is always kept besides). */
export const TIMING_RING_KEEP = 5;

/**
 * Keeps a few durations per fixed code in memory, for the development diagnostics screen. Codes and numbers only: never an id,
 * a path, a url or a message. Polling the list every few seconds must not push the cold first reading out, so the first one
 * of each code is kept apart from the latest ones.
 */
export function createTimingRing(keep: number = TIMING_RING_KEEP): TimingRing {
  const seen = new Map<TimingCode, { first: number; last: number[] }>();
  return {
    record: (code, ms) => {
      if (!Number.isFinite(ms) || ms < 0) return;
      const value = Math.round(ms);
      const entry = seen.get(code);
      if (entry === undefined) {
        seen.set(code, { first: value, last: [value] });
        return;
      }
      entry.last.push(value);
      if (entry.last.length > keep) entry.last.splice(0, entry.last.length - keep);
    },
    summary: () => [...seen].map(([code, entry]) => ({ code, first: entry.first, last: [...entry.last] })),
  };
}

/** The app-wide ring: the durations measured by every stack and work list this process built. */
export const appTimings: TimingRing = createTimingRing();
