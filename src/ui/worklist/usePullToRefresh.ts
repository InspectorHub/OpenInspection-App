import { useEffect, useRef } from 'react';

/** How far a downward drag must go, in CSS pixels, to count as a pull. */
export const PULL_DISTANCE_PX = 80;
/** A finger must travel this far before its direction is judged: a small wobble at the start decides nothing. */
export const TOUCH_SLOP_PX = 10;

function atTop(): boolean {
  const scroller = document.scrollingElement ?? document.documentElement;
  return scroller.scrollTop <= 0 && window.scrollY <= 0;
}

/** A dialog is open: the page behind it must not react to touches. */
function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

/**
 * The pull-down gesture for the page: a drag that starts with one finger at the very top of the page, goes mostly down for at
 * least `PULL_DISTANCE_PX`, and ends with the page still at the top, calls `onRefresh`. It only watches: the listeners are
 * passive and never call `preventDefault`, so the page scrolls exactly as it does without them, and a drag that begins anywhere
 * else is ordinary scrolling and is ignored. The button stays the accessible way to do the same thing.
 */
export function usePullToRefresh(onRefresh: () => void, enabled: boolean): void {
  const latest = useRef(onRefresh);
  latest.current = onRefresh;
  useEffect(() => {
    if (!enabled) return undefined;
    let start: { x: number; y: number } | null = null;
    let pulled = 0;
    let vertical = false;

    const reset = (): void => {
      start = null;
      pulled = 0;
      vertical = false;
    };
    const onStart = (event: TouchEvent): void => {
      const first = event.touches[0];
      if (event.touches.length !== 1 || first === undefined || !atTop() || modalOpen()) {
        reset();
        return;
      }
      start = { x: first.clientX, y: first.clientY };
      pulled = 0;
      vertical = false;
    };
    const onMove = (event: TouchEvent): void => {
      const first = event.touches[0];
      if (start === null || first === undefined) return;
      if (event.touches.length !== 1 || !atTop() || modalOpen()) {
        reset();
        return;
      }
      const dy = first.clientY - start.y;
      const dx = first.clientX - start.x;
      if (!vertical) {
        // The direction is judged once, when the finger has clearly moved: a downward, mostly vertical start is a pull; anything
        // else is a scroll or a swipe and ends the gesture for good.
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= TOUCH_SLOP_PX) return;
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          reset();
          return;
        }
        vertical = true;
      }
      pulled = dy;
    };
    const onEnd = (): void => {
      const done = start !== null && pulled >= PULL_DISTANCE_PX && atTop() && !modalOpen();
      reset();
      if (done) latest.current();
    };

    document.addEventListener('touchstart', onStart, { passive: true });
    document.addEventListener('touchmove', onMove, { passive: true });
    document.addEventListener('touchend', onEnd, { passive: true });
    document.addEventListener('touchcancel', reset, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onStart);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', reset);
    };
  }, [enabled]);
}
