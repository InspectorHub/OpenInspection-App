// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PULL_DISTANCE_PX, TOUCH_SLOP_PX, usePullToRefresh } from './usePullToRefresh';

function Probe({ onRefresh, enabled = true }: { onRefresh: () => void; enabled?: boolean }) {
  usePullToRefresh(onRefresh, enabled);
  return null;
}

function setScroll(top: number): void {
  Object.defineProperty(document.scrollingElement ?? document.documentElement, 'scrollTop', { configurable: true, value: top });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: top });
}

function touch(type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x: number, y: number, fingers = 1): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = Array.from({ length: type === 'touchend' || type === 'touchcancel' ? 0 : fingers }, () => ({ clientX: x, clientY: y }));
  Object.defineProperty(event, 'touches', { value: list });
  act(() => {
    document.body.dispatchEvent(event);
  });
}

const modal = (): HTMLElement => {
  const el = document.createElement('div');
  el.setAttribute('aria-modal', 'true');
  document.body.appendChild(el);
  return el;
};

beforeEach(() => setScroll(0));
afterEach(() => {
  cleanup();
  document.querySelectorAll('[aria-modal]').forEach((el) => el.remove());
  vi.restoreAllMocks();
});

describe('the direction of a pull', () => {
  it('a small sideways wobble at the start does not spoil a pull that is clearly downward', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100 + TOUCH_SLOP_PX - 2, 102);
    touch('touchmove', 108, 140);
    touch('touchmove', 112, 100 + PULL_DISTANCE_PX + 20);
    touch('touchend', 112, 100 + PULL_DISTANCE_PX + 20);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('a slightly diagonal pull still counts', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 130, 160);
    touch('touchmove', 150, 100 + PULL_DISTANCE_PX + 40);
    touch('touchend', 150, 100 + PULL_DISTANCE_PX + 40);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('a clearly horizontal start ends the gesture for good, even if the finger later goes down', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 140, 105);
    touch('touchmove', 140, 100 + PULL_DISTANCE_PX + 60);
    touch('touchend', 140, 100 + PULL_DISTANCE_PX + 60);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a finger that goes up first is a scroll and ends the gesture for good', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 200);
    touch('touchmove', 100, 170);
    touch('touchmove', 100, 400);
    touch('touchend', 100, 400);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a finger that stays inside the slop decides nothing and refreshes nothing', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 104, 106);
    touch('touchend', 104, 106);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a pull that goes back up before the finger lifts does not count', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 40);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX - 30);
    touch('touchend', 100, 100 + PULL_DISTANCE_PX - 30);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('what interrupts a pull', () => {
  it('a dialog that opens in the middle of the gesture cancels it, even if it is gone again at the end', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 140);
    const dialog = modal();
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 30);
    dialog.remove();
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 60);
    touch('touchend', 100, 100 + PULL_DISTANCE_PX + 60);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a dialog that is open when the finger lifts cancels it', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 30);
    modal();
    touch('touchend', 100, 100 + PULL_DISTANCE_PX + 30);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a second finger that joins in the middle cancels it', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 140);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 30, 2);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 60);
    touch('touchend', 100, 100 + PULL_DISTANCE_PX + 60);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('a gesture that starts with two fingers is never a pull, even when one lifts and one keeps going', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100, 2);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 30);
    touch('touchend', 100, 100 + PULL_DISTANCE_PX + 30);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('nothing is left over: a lift with no pull in progress, after a completed pull, does not refresh again', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 30);
    touch('touchend', 100, 100 + PULL_DISTANCE_PX + 30);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    touch('touchend', 100, 300);
    touch('touchend', 100, 300);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('a cancelled gesture is forgotten: a later lift does not refresh', () => {
    const onRefresh = vi.fn();
    render(<Probe onRefresh={onRefresh} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 100 + PULL_DISTANCE_PX + 30);
    touch('touchcancel', 100, 300);
    touch('touchend', 100, 300);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe('the listeners', () => {
  it('are passive, so the page keeps scrolling exactly as before', () => {
    const add = vi.spyOn(document, 'addEventListener');
    render(<Probe onRefresh={() => undefined} />);
    const touchCalls = add.mock.calls.filter(([type]) => String(type).startsWith('touch'));
    expect(touchCalls.map(([type]) => type).sort()).toEqual(['touchcancel', 'touchend', 'touchmove', 'touchstart']);
    for (const [, , options] of touchCalls) expect(options).toEqual({ passive: true });
  });

  it('are all removed when the page goes away or the hook is switched off', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const view = render(<Probe onRefresh={() => undefined} />);
    const added = add.mock.calls.filter(([type]) => String(type).startsWith('touch')).map(([type, handler]) => [type, handler]);
    view.unmount();
    const removed = remove.mock.calls.filter(([type]) => String(type).startsWith('touch')).map(([type, handler]) => [type, handler]);
    expect(removed).toEqual(expect.arrayContaining(added));
    expect(removed).toHaveLength(added.length);

    const onRefresh = vi.fn();
    const again = render(<Probe onRefresh={onRefresh} enabled={false} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 300);
    touch('touchend', 100, 300);
    expect(onRefresh).not.toHaveBeenCalled();
    again.rerender(<Probe onRefresh={onRefresh} enabled />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 300);
    touch('touchend', 100, 300);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('always call the latest function, not the one from the first render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = render(<Probe onRefresh={first} />);
    view.rerender(<Probe onRefresh={second} />);
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 300);
    touch('touchend', 100, 300);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
