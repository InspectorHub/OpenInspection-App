// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld } from '../app/test-support/world';
import { at, createListWorld, seedPkg } from './test-support/worklist-world';
import { SignedIn } from './SignedIn';

// The editor itself is tested elsewhere; here only where the page is scrolled to when it opens and when it closes.
vi.mock('./EditorScreen', () => ({
  EditorScreen: ({ inspectionId, onExit }: { inspectionId: string; onExit(): void }) => (
    <div>
      <p data-testid="editing">{inspectionId}</p>
      <button type="button" onClick={onExit}>
        stub exit
      </button>
    </div>
  ),
}));

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };
let scrollTo: ReturnType<typeof vi.fn>;

function scrolledTo(y: number): void {
  Object.defineProperty(window, 'scrollY', { configurable: true, value: y });
}

beforeEach(() => {
  scrollTo = vi.fn();
  vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as unknown as typeof window.scrollTo);
  scrolledTo(0);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function mount() {
  const world = await createSignedInWorld();
  const list = await createListWorld();
  await seedPkg(list.db, { id: 'a', scheduledAt: at(0) });
  render(
    <OfflineStackContext.Provider value={list.stack}>
      <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
    </OfflineStackContext.Provider>,
  );
  await screen.findByTestId('row-a');
  return { user: userEvent.setup(), open: () => screen.getByTestId('row-a').querySelector('button') as HTMLButtonElement };
}

describe('the work list keeps its place across the editor', () => {
  it('opening the editor scrolls the page to the top, and coming back restores the list position exactly once', async () => {
    const { user, open } = await mount();
    scrolledTo(480);
    await user.click(open());
    expect(await screen.findByTestId('editing')).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(scrollTo).not.toHaveBeenCalledWith(0, 480);

    scrolledTo(1234); // the editor was scrolled meanwhile
    await user.click(screen.getByRole('button', { name: 'stub exit' }));
    await screen.findByTestId('row-a');
    expect(scrollTo.mock.calls.filter(([, y]) => y === 480)).toHaveLength(1);
    expect(scrollTo).not.toHaveBeenCalledWith(0, 1234);
  });

  it('control: a list that was at the top is not scrolled on the way back', async () => {
    const { user, open } = await mount();
    await user.click(open());
    await screen.findByTestId('editing');
    scrollTo.mockClear();
    await user.click(screen.getByRole('button', { name: 'stub exit' }));
    await screen.findByTestId('row-a');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('a second visit restores the position of the second visit, not the first', async () => {
    const { user, open } = await mount();
    scrolledTo(300);
    await user.click(open());
    await user.click(await screen.findByRole('button', { name: 'stub exit' }));
    await screen.findByTestId('row-a');
    scrolledTo(90);
    await user.click(open());
    await user.click(await screen.findByRole('button', { name: 'stub exit' }));
    await screen.findByTestId('row-a');
    expect(scrollTo.mock.calls.filter(([, y]) => y === 90)).toHaveLength(1);
  });

  it('Settings keeps the position too', async () => {
    const { user } = await mount();
    scrolledTo(250);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('button', { name: 'Back to work list' });
    await user.click(screen.getByRole('button', { name: 'Back to work list' }));
    await screen.findByTestId('row-a');
    expect(scrollTo.mock.calls.filter(([, y]) => y === 250)).toHaveLength(1);
  });
});
