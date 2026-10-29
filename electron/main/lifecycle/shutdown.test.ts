import { describe, expect, it, vi } from 'vitest';
import { shutdownDesktop } from './shutdown.ts';

describe('desktop shutdown', () => {
  it('aborts uploads, waits for database opening, rolls back, closes, then clears opening state', async () => {
    const order: string[] = [];
    let finishOpening!: (value: { host: { inTransaction(): boolean; rollback(): void; close(): void } }) => void;
    const host = {
      inTransaction: () => { order.push('transaction?'); return true; },
      rollback: () => { order.push('rollback'); },
      close: () => { order.push('close'); },
    };
    const opening = new Promise<{ host: typeof host }>((resolve) => { finishOpening = resolve; });
    const value: { opening: Promise<{ host: typeof host | null }> | null; host: typeof host | null } = { opening, host: null };
    const state = {
      get opening() { return value.opening; },
      set opening(next) { order.push('opening-cleared'); value.opening = next; },
      get host() { return value.host; },
      set host(next) { value.host = next; },
    };

    const pending = shutdownDesktop({ abortUploads: () => { order.push('abort'); }, state });
    expect(order).toEqual(['abort']);
    finishOpening({ host });
    await pending;

    expect(order).toEqual(['abort', 'transaction?', 'rollback', 'close', 'opening-cleared']);
    expect(state.host).toBeNull();
    expect(state.opening).toBeNull();
  });

  it('clears a rejected opening without closing or committing data and permits a retry', async () => {
    const openingFailure = new Error('private database error text');
    const close = vi.fn();
    const rollback = vi.fn();
    const commit = vi.fn();
    const existingHost = { inTransaction: () => true, rollback, close };
    const state: { opening: Promise<{ host: { inTransaction(): boolean; rollback(): void; close(): void } | null }> | null; host: { inTransaction(): boolean; rollback(): void; close(): void } | null } = {
      opening: Promise.reject(openingFailure),
      host: existingHost,
    };
    const shutdown = () => shutdownDesktop({ abortUploads: vi.fn(), state });

    await expect(shutdown()).rejects.toBe(openingFailure);
    expect(state.opening).toBeNull();
    expect(state.host).toBe(existingHost);
    expect(close).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    const retriedHost = { inTransaction: () => false, rollback, close };
    state.opening = Promise.resolve({ host: retriedHost });
    await shutdown();
    expect(close).toHaveBeenCalledOnce();
    expect(state.opening).toBeNull();
  });
});
