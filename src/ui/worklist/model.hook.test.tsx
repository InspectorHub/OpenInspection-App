// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at, createListWorld, NOW, seedPkg, type ListWorld } from '../test-support/worklist-world';
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
