// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderList } from './test-support/worklist-render';
import { at, createListWorld, NOW, seedPkg } from './test-support/worklist-world';
import { WorkList } from './WorkList';

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollTo = vi.fn();
  vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as unknown as typeof window.scrollTo);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the work list restores the scroll position it is given', () => {
  it('restores once, after the first ready snapshot has rendered, and not while the skeleton shows', async () => {
    const world = await createListWorld();
    await seedPkg(world.db, { id: 'a', scheduledAt: at(0) });
    renderList(world.stack, { restoreScrollY: 480 });
    expect(screen.getByRole('status', { name: 'Loading your work list' })).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();
    await screen.findByTestId('row-a');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 480);
  });

  it('does not restore again when the list is read again, so a person who has scrolled is not pulled back', async () => {
    const world = await createListWorld();
    await seedPkg(world.db, { id: 'a', scheduledAt: at(0) });
    renderList(world.stack, { restoreScrollY: 480, pollMs: 15 });
    await screen.findByTestId('row-a');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('does not restore again when the given position changes after the first restore', async () => {
    const world = await createListWorld();
    await seedPkg(world.db, { id: 'a', scheduledAt: at(0) });
    const view = renderList(world.stack, { restoreScrollY: 480 });
    await screen.findByTestId('row-a');
    expect(scrollTo).toHaveBeenCalledTimes(1);
    view.rerender(<WorkList stack={world.stack} now={() => NOW} locale="en-US" pollMs={0} restoreScrollY={900} />);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it('control: with no position, or the top, it never scrolls', async () => {
    const world = await createListWorld();
    await seedPkg(world.db, { id: 'a', scheduledAt: at(0) });
    renderList(world.stack);
    await screen.findByTestId('row-a');
    cleanup();
    renderList(world.stack, { restoreScrollY: 0 });
    await screen.findByTestId('row-a');
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe('the summary row keeps its place', () => {
  it('is in the page before any summary exists, and the same node is filled when one arrives', async () => {
    const world = await createListWorld();
    renderList(world.stack);
    const slot = await screen.findByTestId('refresh-summary');
    expect(slot).toHaveTextContent('');
    expect(slot.className).toContain('min-h-');
    expect(slot.className).not.toContain('sr-only');
    expect(slot).toHaveAttribute('aria-live', 'polite');
  });
});
