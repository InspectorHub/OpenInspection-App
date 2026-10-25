// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefreshSummary } from '../offline/work-package';
import { refreshSummary, renderList } from './test-support/worklist-render';
import { createListWorld, type ListWorld } from './test-support/worklist-world';

let w: ListWorld;
beforeEach(async () => {
  w = await createListWorld();
  setScroll(0);
});
afterEach(() => {
  cleanup();
  document.querySelectorAll('[aria-modal]').forEach((el) => el.remove());
});

function setScroll(top: number): void {
  Object.defineProperty(document.scrollingElement ?? document.documentElement, 'scrollTop', { configurable: true, value: top });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: top });
}

function touch(type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel', x: number, y: number, touches = 1): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = Array.from({ length: type === 'touchend' || type === 'touchcancel' ? 0 : touches }, () => ({ clientX: x, clientY: y }));
  Object.defineProperty(event, 'touches', { value: list });
  Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
  act(() => {
    document.body.dispatchEvent(event);
  });
}

function pull(dy: number, dx = 0, options: { touches?: number } = {}): void {
  touch('touchstart', 100, 100, options.touches);
  touch('touchmove', 100 + dx / 2, 100 + dy / 2, options.touches);
  touch('touchmove', 100 + dx, 100 + dy, options.touches);
  touch('touchend', 100 + dx, 100 + dy);
}

async function ready() {
  const refresh = vi.spyOn(w.stack.refresher, 'refresh').mockResolvedValue(refreshSummary({ refreshed: 2 }));
  renderList(w.stack);
  await screen.findByRole('button', { name: "Download today's work" });
  return refresh;
}

describe('pulling the list down', () => {
  it('a long downward drag from the top runs the same manual download as the button, once', async () => {
    const refresh = await ready();
    pull(120);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledWith({ reason: 'manual' });
    expect(await screen.findByText('Updated 2 inspections.')).toBeInTheDocument();
  });

  it('a short drag does nothing (control: the long one above does)', async () => {
    const refresh = await ready();
    pull(30);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a drag that starts below the top of the page is scrolling, not a refresh', async () => {
    const refresh = await ready();
    setScroll(300);
    pull(150);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a drag that scrolled the page away from the top before it ended is not a refresh', async () => {
    const refresh = await ready();
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 200);
    setScroll(40);
    touch('touchmove', 100, 260);
    touch('touchend', 100, 260);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a mostly sideways drag is not a refresh', async () => {
    const refresh = await ready();
    pull(100, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('an upward drag is not a refresh', async () => {
    const refresh = await ready();
    pull(-150);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a pinch (two fingers) is not a refresh', async () => {
    const refresh = await ready();
    pull(150, 0, { touches: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a cancelled gesture is not a refresh', async () => {
    const refresh = await ready();
    touch('touchstart', 100, 100);
    touch('touchmove', 100, 260);
    touch('touchcancel', 100, 260);
    touch('touchend', 100, 260);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('nothing happens while a dialog is open', async () => {
    const refresh = await ready();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    pull(150);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });

  it('while a download runs another pull starts nothing (the same single flight as the button)', async () => {
    let finish: (summary: RefreshSummary) => void = () => undefined;
    const refresh = vi.spyOn(w.stack.refresher, 'refresh').mockReturnValue(new Promise<RefreshSummary>((resolve) => (finish = resolve)));
    renderList(w.stack);
    await screen.findByRole('button', { name: "Download today's work" });
    pull(150);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    pull(150);
    pull(150);
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => finish(refreshSummary({ refreshed: 1 })));
  });

  it('never calls preventDefault, so the page keeps scrolling the way it does', async () => {
    await ready();
    const moves: Event[] = [];
    document.body.addEventListener('touchmove', (event) => moves.push(event));
    pull(150);
    expect(moves.length).toBeGreaterThan(0);
    expect(moves.every((event) => !event.defaultPrevented)).toBe(true);
  });

  it('listens only while the list is on screen', async () => {
    const refresh = vi.spyOn(w.stack.refresher, 'refresh').mockResolvedValue(refreshSummary());
    const view = renderList(w.stack);
    await screen.findByRole('button', { name: "Download today's work" });
    view.unmount();
    pull(150);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(refresh).not.toHaveBeenCalled();
  });
});
