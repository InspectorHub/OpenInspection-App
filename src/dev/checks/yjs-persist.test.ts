import { describe, expect, it, vi } from 'vitest';
import { COMPACTION_DEBOUNCE_MS } from '../../collab/y-sqlite';
import { createDiagRig, rowsFor } from '../test-support';
import { COMPACTION_WAIT_CEILING_MS, yjsPersist } from './yjs-persist';

describe('yjs-persist', () => {
  it('compacts after the debounce signal, reloads identical content, clears its rows', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const running = yjsPersist.run(rig.ctx);
    await vi.waitFor(() => {
      expect(rig.timers.delays()).toContain(COMPACTION_DEBOUNCE_MS);
    });
    rig.timers.fireWithDelay(COMPACTION_DEBOUNCE_MS);
    const result = await running;
    expect(result).toMatchObject({ id: 'yjs-persist', ok: true });
    expect(result.detail).toMatch(/^edits=600 rows_after_compaction=[12] reload=identical cleared=yes ms=\d+$/);
    expect(await rowsFor(rig.services, 'ydoc_updates', 'doc_name', 'diag-yjs')).toBe(0);
    expect(rig.timers.pending()).toBe(0);
  });

  it('control: fails with a fixed message when the compaction never runs, and still removes its rows', async () => {
    const rig = await createDiagRig({ signedIn: false });
    const running = yjsPersist.run(rig.ctx);
    await vi.waitFor(() => {
      expect(rig.timers.delays()).toContain(COMPACTION_WAIT_CEILING_MS);
    });
    rig.timers.fireWithDelay(COMPACTION_WAIT_CEILING_MS);
    const result = await running;
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(`compaction=not_run_within_ms=${String(COMPACTION_WAIT_CEILING_MS)} edits=600`);
    expect(await rowsFor(rig.services, 'ydoc_updates', 'doc_name', 'diag-yjs')).toBe(0);
  });
});
