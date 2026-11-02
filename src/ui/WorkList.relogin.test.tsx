// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderList, withStatus } from './test-support/worklist-render';
import { at, createListWorld, seedPkg } from './test-support/worklist-world';

afterEach(cleanup);

const NOTICE = 'Sign in again to keep syncing';

async function listWith(auth: boolean) {
  const world = await createListWorld();
  await seedPkg(world.db, { id: 'a', scheduledAt: at(0) });
  return withStatus(world.stack, { auth });
}

describe('the "Sign in again to keep syncing" notice has a way in', () => {
  it('offers a Sign in again button next to the notice, and a tap calls the callback once', async () => {
    const { stack } = await listWith(true);
    const onSignInAgain = vi.fn();
    renderList(stack, { onSignInAgain });
    await screen.findByTestId('row-a');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onSignInAgain).toHaveBeenCalledTimes(1);
  });

  it('control: signed in normally there is no such button, with or without the callback', async () => {
    const { stack } = await listWith(false);
    renderList(stack, { onSignInAgain: vi.fn() });
    await screen.findByTestId('row-a');
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('control: without a callback the notice stays plain text (no dead button)', async () => {
    const { stack } = await listWith(true);
    renderList(stack);
    await screen.findByTestId('row-a');
    expect(screen.getByText(NOTICE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('the button follows the status: it appears when sign-in is lost and goes when it is restored', async () => {
    const { stack, status } = await listWith(false);
    renderList(stack, { onSignInAgain: vi.fn() });
    await screen.findByTestId('row-a');
    act(() => status.patch({ auth: true }));
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    act(() => status.patch({ auth: false }));
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });
});
