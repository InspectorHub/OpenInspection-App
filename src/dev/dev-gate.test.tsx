// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, createWorld } from '../app/test-support/world';
import { ServerSetup } from '../ui/ServerSetup';
import { SignedIn } from '../ui/SignedIn';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const LABEL = 'Diagnostics (development only)';
const IDENTITY = { userId: 'u1', tenantId: 't1', role: 'inspector' };

async function renderSignedIn() {
  const world = await createSignedInWorld();
  render(<SignedIn services={world.services} origin={world.server.origin} identity={IDENTITY} onSignedOut={vi.fn()} />);
  return userEvent.setup();
}

async function renderSetup() {
  const world = await createWorld();
  render(<ServerSetup services={world.services} onConnected={vi.fn()} initialUrl="" />);
  return userEvent.setup();
}

describe('release build (DEV off)', () => {
  it('the signed-in screen has no diagnostics button', async () => {
    vi.stubEnv('DEV', false);
    await renderSignedIn();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it('the setup screen has no diagnostics button', async () => {
    vi.stubEnv('DEV', false);
    await renderSetup();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByText(LABEL)).toBeNull();
  });
});

describe('development build (DEV on), the control', () => {
  it('the signed-in screen offers the button and it opens the screen', async () => {
    vi.stubEnv('DEV', true);
    const user = await renderSignedIn();
    await user.click(await screen.findByRole('button', { name: LABEL }));
    expect(await screen.findByRole('heading', { name: LABEL })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close diagnostics' }));
    expect(await screen.findByRole('button', { name: LABEL })).toBeInTheDocument();
  });

  it('the setup screen offers the button', async () => {
    vi.stubEnv('DEV', true);
    await renderSetup();
    expect(await screen.findByRole('button', { name: LABEL })).toBeInTheDocument();
  });
});
