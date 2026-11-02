import { describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { INSPECTION } from '../media/test-support/fakes';
import type { InspectionRefresh } from '../offline/work-package';
import { createManualClock } from '../platform/clock';
import { OPEN_REFRESH_MAX_WAIT_MS, OPEN_REFRESH_MIN_AGE_MS } from './local-data-source';
import { envelope } from './test-support/seed-package';
import { world } from './test-support/data-source-world';

const NOW = 1_000_000;

interface RigOptions {
  online?: boolean;
  /** How old the cached copy is; null leaves the seeded `refreshed_at` of 1. */
  ageMs?: number | null;
  refresh?: (inspectionId: string) => Promise<InspectionRefresh>;
  blocked?: boolean;
  /** The connection flag's first answer; until it settles the flag reads offline, as the real one does. */
  ready?: Promise<void>;
}

/** An editor data source over a cached `tagged` inspection whose refresh, when asked, turns it into `per_unit`. */
async function rig(options: RigOptions = {}) {
  const base = await world();
  const clock = createManualClock(NOW);
  const timers = createManualTimers();
  const online = { value: options.online ?? true };
  const calls: string[] = [];
  if (options.ageMs !== null && options.ageMs !== undefined) await base.db.run('UPDATE work_package SET refreshed_at = ? WHERE inspection_id = ?', [NOW - options.ageMs, INSPECTION]);
  if (options.blocked === true) await base.db.run('UPDATE work_package SET purging = 1 WHERE inspection_id = ?', [INSPECTION]);
  const refresher = {
    refreshInspection: async (id: string): Promise<InspectionRefresh> => {
      calls.push(id);
      if (options.refresh !== undefined) return options.refresh(id);
      await base.db.run('UPDATE resource_cache SET body = ? WHERE key = ?', [
        envelope({ inspection: { id, status: 'draft', propertyType: 'multi_family', unitInspectionMode: 'per_unit', templateSnapshot: { schemaVersion: 2, sections: [] } } }),
        `/api/inspections/${id}`,
      ]);
      return { kind: 'refreshed' };
    },
  };
  const make = () => world({ stack: { ...base.stack, refresher }, clock, timers, network: { isOnline: () => online.value, onOnlineChange: () => () => undefined, ready: options.ready } });
  const w = await make();
  return { w, make, calls, timers, online };
}

describe('opening the editor online refreshes a stale cached inspection first', () => {
  it('uses the server row when the cached copy is older than the freshness bound', async () => {
    const { w, calls } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1 });
    expect((await w.source.load(INSPECTION)).unitInspectionMode).toBe('per_unit');
    expect(calls).toEqual([INSPECTION]);
  });

  it('control: a copy refreshed moments ago is used as it is, with no request', async () => {
    const { w, calls } = await rig({ ageMs: 10_000 });
    expect((await w.source.load(INSPECTION)).unitInspectionMode).toBe('tagged');
    expect(calls).toEqual([]);
  });

  it('offline: no request and the cached copy opens (control: the same world online asks once)', async () => {
    const off = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1, online: false });
    expect((await off.w.source.load(INSPECTION)).unitInspectionMode).toBe('tagged');
    expect(off.calls).toEqual([]);
    const on = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1 });
    await on.w.source.load(INSPECTION);
    expect(on.calls).toHaveLength(1);
  });

  it('waits for the connection flag\'s first answer: a flag that reads offline until then still lets the refresh happen', async () => {
    let answer: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { w, calls, online } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1, online: false, ready });
    const loading = w.source.load(INSPECTION);
    await Promise.resolve();
    expect(calls).toEqual([]);
    online.value = true;
    answer();
    expect((await loading).unitInspectionMode).toBe('per_unit');
    expect(calls).toEqual([INSPECTION]);
  });

  it('control: a flag that settles offline asks nothing, and a later open on the same source may still ask', async () => {
    const { w, calls, online } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1, online: false, ready: Promise.resolve() });
    await w.source.load(INSPECTION);
    expect(calls).toEqual([]);
    online.value = true;
    await w.source.load(INSPECTION);
    expect(calls).toEqual([INSPECTION]);
  });

  it('a copy stamped in the future (the clock moved back) is stale, not fresh', async () => {
    const { w, calls } = await rig({ ageMs: -OPEN_REFRESH_MIN_AGE_MS * 10 });
    await w.source.load(INSPECTION);
    expect(calls).toEqual([INSPECTION]);
  });

  it('a refresh that is slow does not hold the editor beyond the cap, and finishing later does not load again', async () => {
    let finish: (value: InspectionRefresh) => void = () => undefined;
    const slow = new Promise<InspectionRefresh>((resolve) => {
      finish = resolve;
    });
    const { w, calls, timers } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1, refresh: () => slow });
    const loading = w.source.load(INSPECTION);
    await vi.waitFor(() => expect(timers.delays()).toContain(OPEN_REFRESH_MAX_WAIT_MS));
    expect(OPEN_REFRESH_MAX_WAIT_MS).toBe(3000);
    timers.fireWithDelay(OPEN_REFRESH_MAX_WAIT_MS);
    expect((await loading).unitInspectionMode).toBe('tagged');
    finish({ kind: 'refreshed' });
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(w.reloads).toBe(0);
  });

  it('asks at most once per open: a second load of the same source does not, a new source (a new open) does', async () => {
    const { w, make, calls } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1 });
    await w.source.load(INSPECTION);
    await w.source.load(INSPECTION);
    expect(calls).toHaveLength(1);
    const again = await make();
    await again.db.run('UPDATE work_package SET refreshed_at = 1 WHERE inspection_id = ?', [INSPECTION]);
    await again.source.load(INSPECTION);
    expect(calls).toHaveLength(2);
  });

  it('a scoped load (one unit, for a command) never refreshes', async () => {
    const { w, calls } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1 });
    await w.source.load(INSPECTION, '_default');
    expect(calls).toEqual([]);
  });

  it('a blocked inspection is refused before any request', async () => {
    const { w, calls } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1, blocked: true });
    await expect(w.source.load(INSPECTION)).rejects.toMatchObject({ code: 'blocked' });
    expect(calls).toEqual([]);
  });

  it('a refresh stopped by sign-in or by the lock opens the cached copy quietly', async () => {
    for (const reason of ['auth', 'locked'] as const) {
      const { w, calls } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1, refresh: () => Promise.resolve({ kind: 'halted', reason }) });
      expect((await w.source.load(INSPECTION)).unitInspectionMode).toBe('tagged');
      expect(calls).toHaveLength(1);
      expect(w.notes).toEqual([]);
      expect(w.exits).toBe(0);
    }
  });

  it('a refresh that throws opens the cached copy', async () => {
    const { w } = await rig({ ageMs: OPEN_REFRESH_MIN_AGE_MS + 1, refresh: () => Promise.reject(new Error('boom')) });
    expect((await w.source.load(INSPECTION)).unitInspectionMode).toBe('tagged');
  });
});
