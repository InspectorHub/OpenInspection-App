// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, createListWorld, NOW, seedPkg, type ListWorld } from '../test-support/worklist-world';
import { appTimings } from '../../app/timings';
import { useWorkListModel, type WorkListStack } from './model';

let w: ListWorld;

beforeEach(async () => {
  w = await createListWorld();
});
afterEach(cleanup);

describe('useWorkListModel: the newest read wins', () => {
  it('an older read that finishes later is discarded', async () => {
    const releases: (() => void)[] = [];
    vi.spyOn(w.stack.store, 'listRows').mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(() => resolve([]));
        }),
    );
    let finished = 0;
    const counted: WorkListStack = {
      ...w.stack,
      reconciler: {
        trigger: (reason) => w.stack.reconciler.trigger(reason),
        onNeedsReconcile: (id) => w.stack.reconciler.onNeedsReconcile(id),
        get last() {
          finished += 1;
          return w.stack.reconciler.last;
        },
      },
    };
    const { result } = renderHook(() => useWorkListModel(counted, { now: () => NOW, pollMs: 0 }));
    // The first read has taken its picture of the database (no packages) and waits at the photo list.
    await waitFor(() => expect(releases).toHaveLength(1));
    await seedPkg(w.db, { id: 'newer', scheduledAt: at(0) });
    let second: Promise<void> = Promise.resolve();
    act(() => {
      second = result.current.reload();
    });
    await waitFor(() => expect(releases).toHaveLength(2));

    await act(async () => {
      releases[1]?.();
      await second;
    });
    expect(result.current.state.snapshot?.rows.map((r) => r.id)).toEqual(['newer']);

    await act(async () => {
      releases[0]?.();
    });
    await waitFor(() => expect(finished).toBe(2));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.snapshot?.rows.map((r) => r.id)).toEqual(['newer']);
  });
});

describe('useWorkListModel: tells the stack when the list has painted', () => {
  it('not while the first read is still running, once after the first snapshot is shown, and not again for later reads', async () => {
    const release: { open: () => void } = { open: () => undefined };
    const real = w.stack.store.listRows.bind(w.stack.store);
    let first = true;
    vi.spyOn(w.stack.store, 'listRows').mockImplementation(async (filter) => {
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          release.open = resolve;
        });
      }
      return real(filter);
    });
    const mark = vi.spyOn(w.stack, 'markListPainted');
    const { result } = renderHook(() => useWorkListModel(w.stack, { now: () => NOW, pollMs: 0 }));
    await waitFor(() => expect(first).toBe(false));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.state.phase).toBe('loading');
    expect(mark).not.toHaveBeenCalled();
    await act(async () => {
      release.open();
    });
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    await waitFor(() => expect(mark).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.reload();
    });
    expect(mark).toHaveBeenCalledTimes(1);
  });

  it('a first read that fails still releases the stack: the list painted its error', async () => {
    vi.spyOn(w.stack.store, 'listRows').mockRejectedValue(new Error('disk'));
    const mark = vi.spyOn(w.stack, 'markListPainted');
    const { result } = renderHook(() => useWorkListModel(w.stack, { now: () => NOW, pollMs: 0 }));
    await waitFor(() => expect(result.current.state.phase).toBe('error'));
    await waitFor(() => expect(mark).toHaveBeenCalledTimes(1));
  });

  it('records how long each snapshot took under the fixed code snapshot_ms', async () => {
    const { result } = renderHook(() => useWorkListModel(w.stack, { now: () => NOW, pollMs: 0 }));
    await waitFor(() => expect(result.current.state.phase).toBe('ready'));
    const after = appTimings.summary().find((entry) => entry.code === 'snapshot_ms');
    expect(after).toBeDefined();
    expect(after?.last.length).toBeGreaterThan(0);
    expect(Number.isInteger(after?.first)).toBe(true);
  });
});
