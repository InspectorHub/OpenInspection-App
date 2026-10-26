// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, rowCounts, seedLocalData, type World } from '../app/test-support/world';
import type { LockReason } from '../offline/lock';
import { Locked } from './Locked';

afterEach(cleanup);

function view(world: World, reason: LockReason) {
  const handlers = { onOutcome: vi.fn(), onSignInRequired: vi.fn(), onCleared: vi.fn() };
  render(<Locked services={world.services} origin={world.server.origin} reason={reason} {...handlers} />);
  return handlers;
}

describe('Sign in again, on a revoked device', () => {
  it('is offered for a revoked device and routes to sign-in without touching the data', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    const { onSignInRequired, onCleared } = view(world, 'revoked');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(onSignInRequired).toHaveBeenCalledTimes(1);
    expect(onCleared).not.toHaveBeenCalled();
    expect(await rowCounts(world.db)).toEqual(before);
    expect(screen.getByRole('button', { name: 'Clear local data' })).toBeInTheDocument();
  });

  it('two taps in one frame route once', async () => {
    const world = await createSignedInWorld();
    const { onSignInRequired } = view(world, 'revoked');
    const button = await screen.findByRole('button', { name: 'Sign in again' });
    button.click();
    button.click();
    await waitFor(() => expect(onSignInRequired).toHaveBeenCalled());
    expect(onSignInRequired).toHaveBeenCalledTimes(1);
  });

  it('control: the other reasons offer Verify online and not Sign in again', async () => {
    const world = await createSignedInWorld();
    for (const reason of ['expired', 'clock'] as const) {
      view(world, reason);
      await screen.findByRole('button', { name: 'Verify online' });
      expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
      cleanup();
    }
  });
});
