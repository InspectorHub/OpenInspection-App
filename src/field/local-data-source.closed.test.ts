import { describe, expect, it, vi } from 'vitest';
import { createManualTimers } from '../collab/test-support/manual-timers';
import { INSPECTION } from '../media/test-support/fakes';
import type { InspectionRefresh } from '../offline/work-package';
import { createManualClock } from '../platform/clock';
import { recordRejected, takeRejected } from './item-tags-notice';
import { OPEN_REFRESH_MAX_WAIT_MS } from './local-data-source';
import { MESSAGES } from './messages';
import type { PhotoCache } from './photo-cache';
import { world } from './test-support/data-source-world';

const NOW = 1_000_000;

/** A stale cached inspection whose refresh is still running, a rejected-tags count waiting, and a photo cache that records its calls. */
async function rig() {
  const base = await world();
  await base.db.run('UPDATE work_package SET refreshed_at = ? WHERE inspection_id = ?', [1, INSPECTION]);
  await recordRejected(base.db, base.stack.account, 2);
  const closed = { value: false };
  const timers = createManualTimers();
  let finish: (value: InspectionRefresh) => void = () => undefined;
  const slow = new Promise<InspectionRefresh>((resolve) => {
    finish = resolve;
  });
  const photoCache = {
    lookup: () => null,
    subscribe: () => () => undefined,
    warm: vi.fn(() => Promise.resolve()),
    prime: vi.fn(() => Promise.resolve([] as string[])),
    sweepOrphans: () => Promise.resolve(0),
    dispose: () => undefined,
    purgeInspection: () => Promise.resolve(),
  } satisfies PhotoCache;
  const w = await world({
    stack: { ...base.stack, refresher: { refreshInspection: () => slow } },
    clock: createManualClock(NOW),
    timers,
    photoCache,
    isClosed: () => closed.value,
  });
  return { w, base, closed, timers, photoCache, finish };
}

describe('an editor that is closed while its open-refresh is still running', () => {
  it('consumes nothing: no toast, the rejected-tags count is kept for the next open, the photo cache is not touched', async () => {
    const { w, base, closed, timers, photoCache } = await rig();
    const loading = w.source.load(INSPECTION);
    await vi.waitFor(() => expect(timers.delays()).toContain(OPEN_REFRESH_MAX_WAIT_MS));
    closed.value = true;
    timers.fireWithDelay(OPEN_REFRESH_MAX_WAIT_MS);
    await loading;
    expect(w.notes).toEqual([]);
    expect(photoCache.warm).not.toHaveBeenCalled();
    expect(photoCache.prime).not.toHaveBeenCalled();
    expect(await takeRejected(base.db, base.stack.account)).toBe(2);
  });

  it('control: not closed, the same load shows the toast once, consumes the count and warms the cache', async () => {
    const { w, base, timers, photoCache } = await rig();
    const loading = w.source.load(INSPECTION);
    await vi.waitFor(() => expect(timers.delays()).toContain(OPEN_REFRESH_MAX_WAIT_MS));
    timers.fireWithDelay(OPEN_REFRESH_MAX_WAIT_MS);
    await loading;
    expect(w.notes).toEqual([[MESSAGES.tagsNotSynced, 'warning']]);
    expect(photoCache.warm).toHaveBeenCalledTimes(1);
    expect(await takeRejected(base.db, base.stack.account)).toBe(0);
  });
});
