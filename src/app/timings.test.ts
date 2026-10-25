import { describe, expect, it } from 'vitest';
import { createTimingRing } from './timings';

describe('the timing ring', () => {
  it('keeps the first duration of each code apart from the latest few, so polling cannot push the cold one out', () => {
    const ring = createTimingRing(3);
    ring.record('snapshot_ms', 900);
    for (const ms of [10, 11, 12, 13]) ring.record('snapshot_ms', ms);
    ring.record('launch_wait_ms', 2500);
    expect(ring.summary()).toEqual([
      { code: 'snapshot_ms', first: 900, last: [11, 12, 13] },
      { code: 'launch_wait_ms', first: 2500, last: [2500] },
    ]);
  });

  it('rounds to whole milliseconds and ignores anything that is not a duration', () => {
    const ring = createTimingRing();
    ring.record('snapshot_ms', 12.6);
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) ring.record('snapshot_ms', bad);
    expect(ring.summary()).toEqual([{ code: 'snapshot_ms', first: 13, last: [13] }]);
  });

  it('hands out a copy', () => {
    const ring = createTimingRing();
    ring.record('snapshot_ms', 5);
    (ring.summary()[0]?.last as number[]).push(99);
    expect(ring.summary()[0]?.last).toEqual([5]);
  });
});
