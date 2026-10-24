import { describe, expect, it } from 'vitest';
import { createManualClock, systemClock } from './clock';

describe('clock', () => {
  it('system clock reports wall time', () => {
    const before = Date.now();
    const t = systemClock.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  it('manual clock only moves when told to, including backwards', () => {
    const clock = createManualClock(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(100);
    expect(clock.now()).toBe(100);
  });
});
