// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSignedInWorld, type World } from '../app/test-support/world';
import { Locked } from './Locked';
import { SignOutControl } from './SignOutControl';

afterEach(cleanup);

function seedFiles(world: World): string {
  world.clock.set(1_800_000_000_000);
  const archive = `inspectorhub-export-${String(world.clock.now() - 1000)}.zip`;
  world.files.seedCache(archive, null);
  world.files.seedCache('unrelated.zip', null);
  return archive;
}

async function signOut(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
}

describe('signing out removes export archives', () => {
  it('an archive left in the cache is removed after a sign-out, and files that are not ours stay', async () => {
    const world = await createSignedInWorld();
    seedFiles(world);
    const onSignedOut = vi.fn();
    render(<SignOutControl services={world.services} origin={world.server.origin} onSignedOut={onSignedOut} />);
    await signOut(userEvent.setup());
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(world.files.cacheNames()).toEqual(['unrelated.zip']);
  });

  it('a sign-out that fails removes nothing (control: the archive stays while the person is still signed in)', async () => {
    const world = await createSignedInWorld();
    const archive = seedFiles(world);
    vi.spyOn(world.services.tokens, 'signOut').mockRejectedValue(new Error('storage'));
    const onSignedOut = vi.fn();
    render(<SignOutControl services={world.services} origin={world.server.origin} onSignedOut={onSignedOut} />);
    await signOut(userEvent.setup());
    await screen.findByRole('alert');
    expect(onSignedOut).not.toHaveBeenCalled();
    expect(world.files.cacheNames().sort()).toEqual([archive, 'unrelated.zip'].sort());
  });

  it('the lock screen does the same on its sign-out and on its clear', async () => {
    const world = await createSignedInWorld();
    seedFiles(world);
    const handlers = { onOutcome: vi.fn(), onSignInRequired: vi.fn(), onCleared: vi.fn() };
    const onSignedOut = vi.fn();
    render(<Locked services={world.services} origin={world.server.origin} reason="expired" {...handlers} onSignedOut={onSignedOut} />);
    await signOut(userEvent.setup());
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(world.files.cacheNames()).toEqual(['unrelated.zip']);
    cleanup();

    const again = await createSignedInWorld();
    seedFiles(again);
    await again.files.write('media/orphan.jpg', new Uint8Array([1]));
    render(<Locked services={again.services} origin={again.server.origin} reason="expired" {...handlers} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    await waitFor(() => expect(handlers.onCleared).toHaveBeenCalledTimes(1));
    expect(again.files.cacheNames()).toEqual(['unrelated.zip']);
    expect(again.files.paths()).toEqual([]);
  });
});
