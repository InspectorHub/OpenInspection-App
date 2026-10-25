import { describe, expect, it } from 'vitest';
import { createDiagnosticRing, DIAGNOSTIC_RING_SIZE } from './diagnostics';

describe('the diagnostic ring', () => {
  it('keeps the latest codes, oldest first, and drops the oldest beyond its capacity', () => {
    const ring = createDiagnosticRing(3);
    expect(ring.recent()).toEqual([]);
    for (const code of ['replay_error', 'refresh_error', 'sweep_failed', 'doc_error'] as const) ring.push(code);
    expect(ring.recent()).toEqual(['refresh_error', 'sweep_failed', 'doc_error']);
  });

  it('hands out a copy: changing it changes nothing in the ring', () => {
    const ring = createDiagnosticRing(3);
    ring.push('replay_error');
    const copy = ring.recent() as string[];
    copy.push('x');
    expect(ring.recent()).toEqual(['replay_error']);
  });

  it('has a small default capacity', () => {
    expect(DIAGNOSTIC_RING_SIZE).toBeGreaterThan(0);
    expect(DIAGNOSTIC_RING_SIZE).toBeLessThanOrEqual(50);
  });
});
