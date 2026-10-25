import { useEffect, useRef } from 'react';
import { backRegistry, type BackHandler } from './back-button';

/**
 * Answers the back key while the calling screen is mounted (and `enabled`). The handler returns true when it used the press up.
 * The most recently mounted screen is asked first. The latest handler is always the one called.
 */
export function useBackHandler(handler: BackHandler, enabled = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    return backRegistry.registerScreen(() => latest.current());
  }, [enabled]);
}

/** Registers an unsaved-work guard while mounted: asked only when the press would otherwise leave the app. */
export function useBackGuard(guard: BackHandler, enabled = true): void {
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    if (!enabled) return undefined;
    return backRegistry.registerGuard(() => latest.current());
  }, [enabled]);
}
