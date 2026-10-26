// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld } from '../app/test-support/world';
import { at, createListWorld, seedPkg } from './test-support/worklist-world';
import { SignedIn } from './SignedIn';

// What the screen does is tested with it; here only how the work list reaches it and gets back.
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

afterEach(cleanup);

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };

describe('SignedIn opens the editor from the work list', () => {
  it('opens the chosen inspection, and the editor leaving shows the list again', async () => {
    const world = await createSignedInWorld();
    const list = await createListWorld();
    await seedPkg(list.db, { id: 'a', scheduledAt: at(0) });
    await seedPkg(list.db, { id: 'b', scheduledAt: at(1) });
    render(
      <OfflineStackContext.Provider value={list.stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
      </OfflineStackContext.Provider>,
    );
    const user = userEvent.setup();
    const row = await screen.findByTestId('row-b');
    expect(screen.queryByTestId('editing')).toBeNull();
    await user.click(row.querySelector('button') as HTMLButtonElement);
    expect(await screen.findByTestId('editing')).toHaveTextContent('b');
    expect(screen.queryByTestId('row-a')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'stub exit' }));
    expect(screen.queryByTestId('editing')).toBeNull();
    expect(await screen.findByTestId('row-a')).toBeInTheDocument();
  });
});
