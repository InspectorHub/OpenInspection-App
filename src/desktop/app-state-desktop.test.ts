import { describe, expect, it, vi } from 'vitest';
import { createDesktopAppState } from './app-state-desktop.ts';

describe('desktop app-state adapter', () => {
  it('forwards active changes and safely unsubscribes', () => {
    let listener: ((active: boolean) => void) | undefined;
    const remove = vi.fn(() => { listener = undefined; });
    const bridge = { app: { onActiveChange: vi.fn((cb: (active: boolean) => void) => { listener = cb; return remove; }) } };
    const port = createDesktopAppState(bridge);
    const onChange = vi.fn();
    const unsubscribe = port.onChange(onChange);
    listener?.(false); listener?.(true);
    unsubscribe(); unsubscribe();
    listener?.(true);
    expect(onChange.mock.calls).toEqual([[false], [true]]);
    expect(remove).toHaveBeenCalledOnce();
  });
});
