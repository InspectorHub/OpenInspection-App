// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineStackContext } from '../app/stack-context';
import { createSignedInWorld } from '../app/test-support/world';
import type { CompatInfo } from '../auth/server-config';
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
