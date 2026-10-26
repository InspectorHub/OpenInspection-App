// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, createWorld } from '../app/test-support/world';
import { Locked } from './Locked';
import { ServerSetup } from './ServerSetup';
import { SignedIn } from './SignedIn';
import { SignIn } from './SignIn';
import { watchUnhandled, type UnhandledWatch } from './test-support/unhandled';

const SECRET = 'boom-secret-detail';
let watch: UnhandledWatch;

beforeEach(() => {
  watch = watchUnhandled();
});
afterEach(async () => {
  await watch.finish();
  cleanup();
  vi.restoreAllMocks();
});

async function expectContained(): Promise<void> {
  expect(await watch.finish()).toEqual([]);
  expect(document.body.textContent).not.toContain(SECRET);
}

describe('the other screens: an action that throws is contained and its text is never shown', () => {
  it('Sign in again (revoked device) when the screen above throws', async () => {
    const world = await createSignedInWorld();
    const onSignInRequired = vi.fn(() => {
      throw new Error(SECRET);
    });
    render(<Locked services={world.services} origin={world.server.origin} reason="revoked" onOutcome={vi.fn()} onSignInRequired={onSignInRequired} onCleared={vi.fn()} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByText('Could not open sign-in. Try again.')).toBeInTheDocument();
    await expectContained();
  });

  it('Verify online when the check throws', async () => {
    const world = await createSignedInWorld();
    vi.spyOn(world.services.tokens, 'checkSession').mockRejectedValue(new Error(SECRET));
    render(<Locked services={world.services} origin={world.server.origin} reason="expired" onOutcome={vi.fn()} onSignInRequired={vi.fn()} onCleared={vi.fn()} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify online' }));
    await screen.findByText(/Verification did not finish|could not verify|Could not reach/);
    await expectContained();
  });

  it('Sign out when the token store throws', async () => {
    const world = await createSignedInWorld();
    vi.spyOn(world.services.tokens, 'signOut').mockRejectedValue(new Error(SECRET));
    render(<SignedIn services={world.services} origin={world.server.origin} identity={{ userId: 'user-1', tenantId: 'tenant-1', role: 'inspector' }} onSignedOut={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    expect(await within(screen.getByRole('alertdialog')).findByRole('alert')).toBeInTheDocument();
    await expectContained();
  });

  it('Sign in when the flow throws', async () => {
    const world = await createWorld();
    vi.spyOn(world.services.flow, 'signIn').mockRejectedValue(new Error(SECRET));
    render(<SignIn services={world.services} origin="https://oi.example.test" relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await expectContained();
  });

  it('Connect when the server check throws', async () => {
    const world = await createWorld({ fetch: () => Promise.reject(new TypeError(SECRET)) });
    render(<ServerSetup services={world.services} onConnected={vi.fn()} devHttpSwitch={false} initialUrl="" />);
    const user = userEvent.setup();
    const input = screen.getByLabelText('Server address');
    await user.clear(input);
    await user.type(input, 'https://oi.example.test');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await expectContained();
  });
});
