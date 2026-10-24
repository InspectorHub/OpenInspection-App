// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, rowCounts, seedLocalData } from '../app/test-support/world';
import { AUTH_ERROR_MESSAGES } from '../auth/errors';
import { refreshTokenKey } from '../auth/server-config';
import { roleLabel, SignedIn } from './SignedIn';

afterEach(cleanup);

const OTHER_ORIGIN = 'https://other.example.test';
const identity = { userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' };
const OWNER_IDENTITY = { userId: 'user-1', tenantId: 'tenant-SECRET-ID', role: 'owner' };

/** Taps Sign out and returns the confirmation dialog it opens. */
async function openDialog(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  return screen.getByRole('alertdialog');
}

describe('SignedIn sign out', () => {
  it('asks first: tapping Sign out opens the dialog and signs nobody out', async () => {
    const world = await createSignedInWorld();
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    const onSignedOut = vi.fn();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={onSignedOut} />);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    const dialog = await openDialog(userEvent.setup());

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Sign out of this device?');
    expect(dialog).toHaveAccessibleDescription(/stay on this device/i);
    expect(dialog).toHaveAccessibleDescription(/need a network connection/i);
    expect(signOut).not.toHaveBeenCalled();
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeTruthy();
  });

  it('focus moves into the dialog on Cancel, and Escape closes it and returns focus to the trigger', async () => {
    const world = await createSignedInWorld();
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Sign out' });
    const dialog = await openDialog(user);
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(trigger).toHaveFocus();
    expect(signOut).not.toHaveBeenCalled();
  });

  it('Tab stays inside the dialog', async () => {
    const world = await createSignedInWorld();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Sign out' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('Cancel closes the dialog without signing out', async () => {
    const world = await createSignedInWorld();
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeTruthy();
  });

  it('confirming wipes only this origin token and keeps every row of local data', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.store.set(refreshTokenKey(OTHER_ORIGIN), 'other-server-token');
    const before = await rowCounts(world.db);
    const onSignedOut = vi.fn();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={onSignedOut} />);
    const user = userEvent.setup();
    const dialog = await openDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
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

  it('two taps on the confirm button in one frame sign out once', async () => {
    const world = await createSignedInWorld();
    const signOut = vi.spyOn(world.services.tokens, 'signOut');
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    const dialog = await openDialog(userEvent.setup());
    const confirm = within(dialog).getByRole('button', { name: 'Sign out' });
    act(() => {
      confirm.click();
      confirm.click();
    });
    await vi.waitFor(() => expect(signOut).toHaveBeenCalled());
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a sign-out that fails shows the fixed message in the dialog, stays signed in, and can be tried again', async () => {
    const world = await createSignedInWorld();
    const signOut = vi.spyOn(world.services.tokens, 'signOut').mockRejectedValueOnce(new Error('SERVER-TEXT-MUST-NOT-BE-SHOWN'));
    const onSignedOut = vi.fn();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={onSignedOut} />);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(AUTH_ERROR_MESSAGES.storage_failed);
    expect(document.body.textContent).not.toContain('SERVER-TEXT');
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Sign out' })).toBeEnabled();

    signOut.mockResolvedValueOnce(undefined);
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await vi.waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it('while signing out, Cancel is disabled and Escape does not close the dialog', async () => {
    const world = await createSignedInWorld();
    let finish: () => void = () => undefined;
    vi.spyOn(world.services.tokens, 'signOut').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<SignedIn services={world.services} origin={world.server.origin} identity={identity} onSignedOut={vi.fn()} />);
    const user = userEvent.setup();
    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await act(async () => {
      finish();
    });
  });
});

describe('SignedIn identity', () => {
  it('shows the role through a fixed label and never the server-supplied tenant id', async () => {
    const world = await createSignedInWorld();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={OWNER_IDENTITY} onSignedOut={vi.fn()} />);
    expect(screen.getByTestId('identity-role')).toHaveTextContent('Owner');
    expect(document.body.textContent).not.toContain('tenant-SECRET-ID');
    expect(screen.queryByTestId('identity-tenant')).toBeNull();
  });

  it('maps the known roles to fixed labels and any other text to a neutral one', () => {
    expect(roleLabel('owner')).toBe('Owner');
    expect(roleLabel('manager')).toBe('Manager');
    expect(roleLabel('inspector')).toBe('Inspector');
    expect(roleLabel('<b>admin</b>')).toBe('Team member');
    expect(roleLabel('constructor')).toBe('Team member');
  });

  it('a hostile role string is not rendered', async () => {
    const world = await createSignedInWorld();
    render(<SignedIn services={world.services} origin={world.server.origin} identity={{ ...identity, role: 'ROLE-FROM-SERVER-TEXT' }} onSignedOut={vi.fn()} />);
    expect(document.body.textContent).not.toContain('ROLE-FROM-SERVER-TEXT');
  });
});
