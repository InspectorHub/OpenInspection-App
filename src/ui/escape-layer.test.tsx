// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backRegistry, createBackRegistry, pressBack } from './back-button';
import { escapeLayerCount, useEscapeLayer } from './escape-layer';
import { useBackGuard, useBackHandler } from './use-back-handler';

afterEach(cleanup);

function Layer({ onEscape }: { onEscape: () => void }) {
  useEscapeLayer(onEscape);
  return <p>layer</p>;
}

const escape = (): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  return event;
};

describe('useEscapeLayer', () => {
  it('closes the layer on Escape and marks the event as used up', () => {
    const onEscape = vi.fn();
    render(<Layer onEscape={onEscape} />);
    const event = escape();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores other keys (positive control: Escape is what answers)', () => {
    const onEscape = vi.fn();
    render(<Layer onEscape={onEscape} />);
    const other = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    window.dispatchEvent(other);
    expect(onEscape).not.toHaveBeenCalled();
    expect(other.defaultPrevented).toBe(false);
    escape();
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('only the topmost of two layers answers, and the one below answers after it is gone', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    render(<Layer onEscape={lower} />);
    const second = render(<Layer onEscape={upper} />);
    escape();
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
    second.unmount();
    escape();
    expect(lower).toHaveBeenCalledTimes(1);
  });

  it('leaves no listener and no layer behind once everything is unmounted', () => {
    const onEscape = vi.fn();
    const view = render(<Layer onEscape={onEscape} />);
    expect(escapeLayerCount()).toBe(1);
    view.unmount();
    expect(escapeLayerCount()).toBe(0);
    const event = escape();
    expect(onEscape).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('an event that was already used up by something else is not answered again', () => {
    const onEscape = vi.fn();
    const early = (event: KeyboardEvent): void => event.preventDefault();
    window.addEventListener('keydown', early);
    render(<Layer onEscape={onEscape} />);
    escape();
    window.removeEventListener('keydown', early);
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('always calls the latest handler, not the one from the first render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Layer onEscape={first} />);
    view.rerender(<Layer onEscape={second} />);
    escape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('a layer that declines', () => {
  it('leaves the event unused, so the press goes on down the back chain', () => {
    const onEscape = vi.fn(() => false);
    render(<Layer onEscape={onEscape} />);
    const event = escape();
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('a layer and the back key', () => {
  it('a back press closes the layer first and does not leave the app; a second press leaves it', () => {
    const registry = createBackRegistry();
    const exit = vi.fn();
    const onEscape = vi.fn();
    const view = render(<Layer onEscape={() => { onEscape(); view.unmount(); }} />);
    pressBack(registry, { exitApp: exit, escapeTarget: window });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    pressBack(registry, { exitApp: exit, escapeTarget: window });
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

function Screen({ handler, enabled = true }: { handler: () => boolean; enabled?: boolean }) {
  useBackHandler(handler, enabled);
  return <p>screen</p>;
}

describe('useBackHandler', () => {
  it('registers while mounted and enabled, and removes itself on unmount', () => {
    const before = backRegistry.size();
    const handler = vi.fn(() => true);
    const view = render(<Screen handler={handler} />);
    expect(backRegistry.size()).toBe(before + 1);
    const exit = vi.fn();
    pressBack(backRegistry, { exitApp: exit, escapeTarget: window });
    expect(handler).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(backRegistry.size()).toBe(before);
  });

  it('is not registered while disabled (control: the same handler answers once enabled)', () => {
    const before = backRegistry.size();
    const handler = vi.fn(() => true);
    const view = render(<Screen handler={handler} enabled={false} />);
    expect(backRegistry.size()).toBe(before);
    view.rerender(<Screen handler={handler} enabled />);
    expect(backRegistry.size()).toBe(before + 1);
  });

  it('calls the latest handler without registering again on every render', () => {
    const before = backRegistry.size();
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const view = render(<Screen handler={first} />);
    view.rerender(<Screen handler={second} />);
    expect(backRegistry.size()).toBe(before + 1);
    pressBack(backRegistry, { exitApp: vi.fn(), escapeTarget: window });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

function Guarded({ guard }: { guard: () => boolean }) {
  useBackGuard(guard);
  return <p>guarded</p>;
}

describe('useBackGuard', () => {
  it('keeps the person in the app while mounted, and lets the app exit once it is gone', () => {
    const exit = vi.fn();
    const guard = vi.fn(() => true);
    const view = render(<Guarded guard={guard} />);
    pressBack(backRegistry, { exitApp: exit, escapeTarget: window });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    view.unmount();
    pressBack(backRegistry, { exitApp: exit, escapeTarget: window });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
