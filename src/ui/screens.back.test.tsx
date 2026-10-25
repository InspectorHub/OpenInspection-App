// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeldAuthSession, createSignedInWorld, createWorld, rowCounts, seedLocalData, type HeldAuthSession } from '../app/test-support/world';
import { refreshTokenKey } from '../auth/server-config';
import { backRegistry, pressBack } from './back-button';
import { Locked } from './Locked';
import { ServerSetup } from './ServerSetup';
import { SignIn } from './SignIn';

afterEach(cleanup);

const ORIGIN = 'https://oi.example.test';
const press = (exit = vi.fn()): (() => void) => {
  act(() => pressBack(backRegistry, { exitApp: exit, escapeTarget: window }));
  return exit;
};

describe('the back key on the sign-in screens', () => {
  it('sign-in at the root: the back key leaves the app (nothing to go back to)', async () => {
    const world = await createWorld();
    render(<SignIn services={world.services} origin={ORIGIN} relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} />);
    const exit = vi.fn();
    press(exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('sign-in reached from the lock screen: the back key is the Back button', async () => {
    const world = await createWorld();
    const onBack = vi.fn();
    render(<SignIn services={world.services} origin={ORIGIN} relogin notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} onBack={onBack} />);
    const exit = vi.fn();
    press(exit);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it('while the sign-in page is open the back key neither leaves the app nor goes back', async () => {
    let held: HeldAuthSession | null = null;
    const world = await createWorld({ authSession: (server) => (held = createHeldAuthSession(server)) });
    const onBack = vi.fn();
    render(<SignIn services={world.services} origin={ORIGIN} relogin notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} onBack={onBack} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect((held as HeldAuthSession | null)?.opened).toBe(1));
    const exit = vi.fn();
    press(exit);
    expect(onBack).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('the back key on the server screen', () => {
  it('on the address check it returns to the address, like "Change address"; on the address it leaves the app', async () => {
    const world = await createWorld();
    render(<ServerSetup services={world.services} onConnected={vi.fn()} devHttpSwitch={false} initialUrl={ORIGIN} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByTestId('canonical-origin')).toBeInTheDocument();
    const exit = vi.fn();
    press(exit);
    expect(screen.queryByTestId('canonical-origin')).toBeNull();
    expect(screen.getByLabelText('Server address')).toBeInTheDocument();
    expect(exit).not.toHaveBeenCalled();
    press(exit);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('Locked: sign out', () => {
  it('shows Sign out only when the app can act on it (control: with the handler it appears)', async () => {
    const world = await createSignedInWorld();
    const handlers = { onOutcome: vi.fn(), onSignInRequired: vi.fn(), onCleared: vi.fn() };
    render(<Locked services={world.services} origin={world.server.origin} reason="expired" {...handlers} />);
    expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    cleanup();
    render(<Locked services={world.services} origin={world.server.origin} reason="expired" {...handlers} onSignedOut={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it.each(['expired', 'clock', 'revoked'] as const)('when locked for %s a confirmed sign-out removes the sign-in and keeps every row', async (reason) => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const onSignedOut = vi.fn();
    render(<Locked services={world.services} origin={world.server.origin} reason={reason} onOutcome={vi.fn()} onSignInRequired={vi.fn()} onCleared={vi.fn()} onSignedOut={onSignedOut} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(world.store.entries()[refreshTokenKey(world.server.origin)]).toBeUndefined();
    expect(await rowCounts(world.db)).toEqual(before);
  });
});
