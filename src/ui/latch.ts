import { useCallback, useRef } from 'react';

/**
 * A same-frame guard. State such as `busy` only changes on the next render, so two taps that
 * land in one frame would both start the action; a ref changes at once. The second call is
 * dropped while the first is running.
 */
export function useActionLatch(): (action: () => Promise<void>) => Promise<void> {
  const held = useRef(false);
  return useCallback(async (action) => {
    if (held.current) return;
    held.current = true;
    try {
      await action();
    } finally {
      held.current = false;
    }
  }, []);
}
