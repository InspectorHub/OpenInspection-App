// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSignedInWorld, restartOffline, seedLocalData, type World } from './app/test-support/world';
import { DAY_MS } from './offline/lock';
import { fakeScheduler } from './offline/test-support/fakes';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

async function clearFromSettings(world: World) {
  const scheduler = fakeScheduler();
  render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Settings' }));
  await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
  await user.click(await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Continue' }));
  await user.click(await within(await screen.findByRole('alertdialog')).findByRole('button', { name: 'Delete everything' }));
  return { scheduler, user };
}

describe('Clear local data from Settings', () => {
  it('with every file removed the person lands on sign-in, never on the lock screen', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    await clearFromSettings(world);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Verification needed' })).toBeNull();
  });

  it('a file that cannot be removed is reported first, and closing the report lands on sign-in', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    world.files.failRemoveFor('/p');
    const { user, scheduler } = await clearFromSettings(world);
    const result = await screen.findByRole('dialog', { name: 'Local data cleared' });
    expect(result).toHaveTextContent('1 photo file could not be removed');
    // The minute check fires while the report is still open.
    act(() => scheduler.tick());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole('dialog', { name: 'Local data cleared' })).toBeInTheDocument();
    await user.click(within(result).getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Verification needed' })).toBeNull();
  });

  it('the lock check does not run while the report is open: the wiped verification marks never turn into the lock screen', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    world.files.failRemoveFor('/p');
    const { scheduler } = await clearFromSettings(world);
    await screen.findByRole('dialog', { name: 'Local data cleared' });
    expect(scheduler.active()).toBe(0);
    world.clock.advance(31 * DAY_MS);
    act(() => scheduler.tick());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('heading', { name: 'Verification needed' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Local data cleared' })).toBeInTheDocument();
  });

  it('control: before any clear the same screen is watched by the lock check', async () => {
    const world = await createSignedInWorld();
    const scheduler = fakeScheduler();
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} />);
    await screen.findByRole('button', { name: 'Settings' });
    await waitFor(() => expect(scheduler.active()).toBe(1));
  });
});
