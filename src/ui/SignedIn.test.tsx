// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, rowCounts, seedLocalData } from '../app/test-support/world';
import { AUTH_ERROR_MESSAGES } from '../auth/errors';
import { refreshTokenKey } from '../auth/server-config';
import { SignedIn } from './SignedIn';

afterEach(cleanup);

const OTHER_ORIGIN = 'https://other.example.test';
const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };

describe('SignedIn sign out', () => {
  it('wipes only this origin token and keeps every row of local data', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.store.set(refreshTokenKey(OTHER_ORIGIN), 'other-server-token');
    const before = await rowCounts(world.db);
    const onSignedOut = vi.fn();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={onSignedOut} />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));

    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeUndefined();
    expect(world.store.entries()[refreshTokenKey(OTHER_ORIGIN)]).toBe('other-server-token');
    const after = await rowCounts(world.db);
    expect(after).toEqual(before);
    expect(before.media).toBe(1);
    expect(before.outbox).toBe(1);
    expect(before.ydoc_updates).toBe(1);
  });

  it('says that local data is kept', async () => {
    const world = await createSignedInWorld();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    expect(screen.getByText(/stay on the device/i)).toBeInTheDocument();
  });

  it('two taps in one frame sign out once', async () => {
    const world = await createSignedInWorld();
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Sign out' });
    act(() => {
      button.click();
      button.click();
    });
    await vi.waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a sign-out that fails shows the fixed message and stays signed in', async () => {
    const world = await createSignedInWorld();
    vi.spyOn(world.services.tokens, 'signOut').mockRejectedValue(new Error('SERVER-TEXT-MUST-NOT-BE-SHOWN'));
    const onSignedOut = vi.fn();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={onSignedOut} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.storage_failed);
    expect(document.body.textContent).not.toContain('SERVER-TEXT');
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
  });
});
