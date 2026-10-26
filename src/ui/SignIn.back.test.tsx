// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHeldAuthSession, createWorld, type HeldAuthSession } from '../app/test-support/world';
import { SignIn } from './SignIn';

afterEach(cleanup);

const ORIGIN = 'https://oi.example.test';

async function worldWithHeldSignIn() {
  let held: HeldAuthSession | null = null;
  const world = await createWorld({ authSession: (server) => (held = createHeldAuthSession(server)) });
  return { world, held: () => held };
}

describe('SignIn Back', () => {
  it('shows no Back when the caller cannot go back', async () => {
    const { world } = await worldWithHeldSignIn();
    render(<SignIn services={world.services} origin={ORIGIN} relogin={false} notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('calls onBack when the caller can go back', async () => {
    const { world } = await worldWithHeldSignIn();
    const onBack = vi.fn<() => void>();
    render(<SignIn services={world.services} origin={ORIGIN} relogin notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} onBack={onBack} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('hides Back while a login is open', async () => {
    const { world, held } = await worldWithHeldSignIn();
    render(<SignIn services={world.services} origin={ORIGIN} relogin notices={[]} onSignedIn={vi.fn()} onChangeServer={vi.fn()} onBack={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(held()?.opened).toBe(1));
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });
});
