// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useActionLatch } from './latch';

describe('useActionLatch', () => {
  it('drops a second call made while the first is running', async () => {
    const { result } = renderHook(() => useActionLatch());
    let finish: () => void = () => undefined;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = result.current(action);
    await result.current(action);
    expect(action).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it('is released when the action throws something unexpected, so the next call runs', async () => {
    const { result } = renderHook(() => useActionLatch());
    const failing = vi.fn(() => Promise.reject(new TypeError('not an AuthError')));
    await expect(result.current(failing)).rejects.toThrow('not an AuthError');

    const next = vi.fn(() => Promise.resolve());
    await result.current(next);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('is released after a normal finish (control)', async () => {
    const { result } = renderHook(() => useActionLatch());
    const action = vi.fn(() => Promise.resolve());
    await result.current(action);
    await result.current(action);
    expect(action).toHaveBeenCalledTimes(2);
  });
});
