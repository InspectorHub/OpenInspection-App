// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld } from '../app/test-support/world';
import type { CompatInfo } from '../auth/server-config';
import { withStatus } from './test-support/worklist-render';
import { createListWorld, seedPkg, at } from './test-support/worklist-world';
import { SignedIn } from './SignedIn';

afterEach(cleanup);

const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };

function compat(over: Partial<CompatInfo>): CompatInfo {
  return { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, serverTooOld: false, nativeLoginVerified: false, ...over };
}

describe('SignedIn shows the client notices without taking anything away', () => {
  it('control: with nothing asked of the person there is no notice at all', async () => {
    const world = await createSignedInWorld();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('update required: the notice is there, and the work list, the account and Sign out are all still there', async () => {
    const world = await createSignedInWorld();
    const list = await createListWorld();
    await seedPkg(list.db, { id: 'a', scheduledAt: at(0) });
    render(
      <OfflineStackContext.Provider value={list.stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
      </OfflineStackContext.Provider>,
    );
    act(() => world.services.clientState.applyCompat(world.server.origin, compat({ minSupported: '9.0.0' })));
    expect(await screen.findByRole('heading', { level: 2, name: 'Update required' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Work list' })).toBeInTheDocument();
    expect(await screen.findByTestId('row-a')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });

  it('server too old: the notice is there, and the screen is otherwise the same', async () => {
    const world = await createSignedInWorld();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    act(() => world.services.clientState.applyCompat(world.server.origin, compat({ serverTooOld: true })));
    expect(await screen.findByRole('heading', { level: 2, name: 'Server version too old' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});

describe('one panel owns the update requirement, and it leaves with the requirement', () => {
  it('a halted stack that says "upgrade" adds no second line; the panel is the only text about it', async () => {
    const world = await createSignedInWorld();
    const list = await createListWorld();
    const { stack, status } = withStatus(list.stack);
    render(
      <OfflineStackContext.Provider value={stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
      </OfflineStackContext.Provider>,
    );
    act(() => {
      world.services.clientState.applyCompat(world.server.origin, compat({ minSupported: '9.0.0' }));
      status.patch({ upgrade: true });
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Update required' })).toBeInTheDocument();
    expect(screen.queryByText('Update the app to keep syncing')).toBeNull();
    expect(screen.queryByText(/update the app to keep syncing/i)).toBeNull();
  });

  it('the requirement withdrawn by a later compat answer clears the panel and leaves no text about it', async () => {
    const world = await createSignedInWorld();
    const list = await createListWorld();
    const { stack, status } = withStatus(list.stack);
    render(
      <OfflineStackContext.Provider value={stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
      </OfflineStackContext.Provider>,
    );
    act(() => {
      world.services.clientState.applyCompat(world.server.origin, compat({ minSupported: '9.0.0' }));
      status.patch({ upgrade: true });
    });
    await screen.findByRole('heading', { level: 2, name: 'Update required' });
    act(() => world.services.clientState.applyCompat(world.server.origin, compat({})));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Update required' })).toBeNull());
    expect(screen.queryByText(/update the app/i)).toBeNull();
    expect(screen.queryByText(/no longer accepted/i)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('heading order', () => {
  it('the first-level heading comes before every second-level notice heading, with and without an offline stack', async () => {
    const world = await createSignedInWorld();
    const plain = render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    act(() => world.services.clientState.applyCompat(world.server.origin, compat({ minSupported: '9.0.0', serverTooOld: true })));
    await screen.findByRole('heading', { level: 2, name: 'Update required' });
    const order = (): number[] => screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
    expect(order()[0]).toBe(1);
    plain.unmount();

    const list = await createListWorld();
    render(
      <OfflineStackContext.Provider value={list.stack}>
        <SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />
      </OfflineStackContext.Provider>,
    );
    await screen.findByRole('heading', { level: 2, name: 'Update required' });
    expect(order()[0]).toBe(1);
    expect(order().filter((level) => level === 1)).toHaveLength(1);
  });
});
