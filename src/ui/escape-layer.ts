import { useEffect, useRef } from 'react';

/**
 * The open modal layers, bottom to top. One window listener serves all of them and exists only while a layer is open.
 * An Escape key event (a keyboard, or the one the back key sends before it does anything else, see `back-button.ts`) is
 * answered by the topmost layer alone, which marks the event as used up.
 */
const layers: Array<{ current: () => void }> = [];

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = layers[layers.length - 1];
  if (top === undefined) return;
  event.preventDefault();
  top.current();
}

/** How many layers are open. For tests and leak checks. */
export function escapeLayerCount(): number {
  return layers.length;
}

/** Registers a layer that closes itself with `onEscape` when Escape reaches the window. The layer stays registered while mounted. */
export function useEscapeLayer(onEscape: () => void): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;
  useEffect(() => {
    const layer = { current: () => latest.current() };
    if (layers.length === 0) window.addEventListener('keydown', onKeyDown);
    layers.push(layer);
    return () => {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      if (layers.length === 0) window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
