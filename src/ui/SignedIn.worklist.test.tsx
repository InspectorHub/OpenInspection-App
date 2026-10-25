// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld } from '../app/test-support/world';
import { renderList, withStatus } from './test-support/worklist-render';
import { at, createListWorld, seedPkg } from './test-support/worklist-world';
import { SignedIn } from './SignedIn';

afterEach(cleanup);

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };

describe('SignedIn with the work list', () => {
  it('shows the work list, the role and the server, and keeps the sign-out dialog', async () => {
    const world = await createSignedInWorld();
    const list = await createListWorld();
    await seedPkg(list.db, { id: 'a', scheduledAt: at(0) });
    const onSignedOut = vi.fn();
    const { container } = render(
      <OfflineStackContext.Provider value={list.stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={onSignedOut} />
      </OfflineStackContext.Provider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Work list' })).toBeInTheDocument();
    expect(await screen.findByTestId('row-a')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByTestId('identity-role')).toHaveTextContent('Inspector');
    expect(container.querySelector('main')?.className).toContain('max-w-md');
    expect(container.querySelector('main')?.className).toContain('md:max-w-2xl');

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
  });

  it('without an offline stack it shows the title and the account, and no list controls', async () => {
    const world = await createSignedInWorld();
    const { container } = render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Work list' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "Download today's work" })).toBeNull();
    expect(container.querySelector('main')?.className).not.toContain('md:max-w-2xl');
  });
});

describe('the work list ends cleanly', () => {
  it('after unmount it reads nothing more: no status listener, no interval', async () => {
    const list = await createListWorld();
    const { stack, status } = withStatus(list.stack);
    const view = renderList(stack, { pollMs: 15 });
    await screen.findByText('Not updated yet');
    view.unmount();
    const query = vi.spyOn(list.db, 'query');
    status.patch({ collabIssue: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(query).not.toHaveBeenCalled();
  });
});
