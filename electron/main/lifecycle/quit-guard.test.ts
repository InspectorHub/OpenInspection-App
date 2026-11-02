import { describe, expect, it, vi } from 'vitest';
import { createQuitGuard } from './quit-guard.ts';
import { developmentQuitAnswer } from './quit-guard.ts';

describe('development quit answer', () => {
  it('can answer the native quit prompt in a development-only E2E run', () => {
    expect(developmentQuitAnswer(false, 'stay')).toBe('stay');
    expect(developmentQuitAnswer(false, 'quit')).toBe('quit');
    expect(developmentQuitAnswer(false, 'unexpected')).toBeNull();
  });

  it('ignores the E2E answer in a packaged app', () => {
    expect(developmentQuitAnswer(true, 'stay')).toBeNull();
  });
});

describe('desktop quit guard', () => {
  it('waits for confirmation and shutdown before requesting one allowed quit', async () => {
    let answer!: (value: 'quit' | 'stay') => void;
    let finishShutdown!: () => void;
    const order: string[] = [];
    const guard = createQuitGuard({ uploads: () => 2, confirm: () => { order.push('confirm'); return new Promise((resolve) => { answer = resolve; }); },
      shutdown: () => { order.push('shutdown'); return new Promise<void>((resolve) => { finishShutdown = resolve; }); },
      quit: () => { order.push('quit'); void guard.onClose({ preventDefault: () => { order.push('prevented'); } }); } });
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };

    const pending = guard.onClose(event);
    expect(event.defaultPrevented).toBe(true);
    expect(order).toEqual(['confirm']);
    answer('quit');
    await vi.waitFor(() => expect(order).toEqual(['confirm', 'shutdown']));
    expect(order).toEqual(['confirm', 'shutdown']);
    const repeatedClose = { prevented: false, preventDefault() { this.prevented = true; } };
    const repeated = guard.onClose(repeatedClose);
    expect(repeatedClose.prevented).toBe(true);
    finishShutdown();
    await pending;
    await repeated;
    expect(order).toEqual(['confirm', 'shutdown', 'quit']);
    expect(order).not.toContain('prevented');
  });

  it('stays open on Stay and gracefully shuts down without confirmation when no uploads are active', async () => {
    const confirm = vi.fn(async () => 'stay' as const);
    const shutdown = vi.fn(async () => {});
    const quit = vi.fn();
    const guard = createQuitGuard({ uploads: () => 1, confirm, shutdown, quit });
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    await guard.onClose(event);
    expect(event.prevented).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
    expect(shutdown).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();

    const noUploads = createQuitGuard({ uploads: () => 0, confirm, shutdown, quit });
    const passThrough = { preventDefault: vi.fn() };
    await noUploads.onClose(passThrough);
    expect(passThrough.preventDefault).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledOnce();
  });

  it('keeps repeated closes suppressed while confirmation is pending', async () => {
    let answer!: (value: 'quit' | 'stay') => void;
    const guard = createQuitGuard({ uploads: () => 1, confirm: () => new Promise((resolve) => { answer = resolve; }), shutdown: async () => {}, quit: vi.fn() });
    const first = { preventDefault: vi.fn() };
    const second = { preventDefault: vi.fn() };
    const firstPending = guard.onClose(first);
    const secondPending = guard.onClose(second);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(second.preventDefault).toHaveBeenCalledOnce();
    answer('stay');
    await Promise.all([firstPending, secondPending]);
  });

  it('does not open the close gate or quit when shutdown fails', async () => {
    const shutdown = vi.fn().mockRejectedValue(new Error('close failed'));
    const quit = vi.fn();
    const guard = createQuitGuard({ uploads: () => 1, confirm: async () => 'quit', shutdown, quit });
    const first = { preventDefault: vi.fn() };
    await expect(guard.onClose(first)).rejects.toThrow('close failed');
    expect(first.preventDefault).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    const retry = { preventDefault: vi.fn() };
    await expect(guard.onClose(retry)).rejects.toThrow('close failed');
    expect(retry.preventDefault).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
    expect(shutdown).toHaveBeenCalledTimes(2);
  });
});
