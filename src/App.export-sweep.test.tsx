// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSignedInWorld, restartOffline, type World } from './app/test-support/world';
import { exportFileName } from './export/format';
import { DAY_MS } from './offline/lock';
import { fakeAppState, fakeScheduler } from './offline/test-support/fakes';

configure({ asyncUtilTimeout: 5000 });
afterEach(cleanup);

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 26, 12, 0, 0);

/** An export archive in the cache that was started `ageMs` before the world's clock. */
function seedArchive(world: World, ageMs: number): string {
  const name = exportFileName(world.clock.now() - ageMs);
  world.files.seedCache(name, null);
  return name;
}

describe('archives left in the cache are swept by age', () => {
  it('at start: ten minutes old goes, nine minutes old stays, other files stay', async () => {
    const world = await createSignedInWorld({ startMs: START });
    const old = seedArchive(world, 10 * MINUTE);
    const young = seedArchive(world, 9 * MINUTE);
    world.files.seedCache('camera.tmp', null);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    await screen.findByRole('heading', { name: 'Work list' });
    await waitFor(() => expect(world.files.cacheNames()).not.toContain(old));
    expect(world.files.cacheNames().sort()).toEqual([young, 'camera.tmp'].sort());
  });

  it('when the app returns to the foreground', async () => {
    const world = await createSignedInWorld({ startMs: START });
    const appState = fakeAppState();
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} appState={appState} />);
    await screen.findByRole('heading', { name: 'Work list' });
    const old = seedArchive(world, 11 * MINUTE);
    const young = seedArchive(world, 2 * MINUTE);
    act(() => appState.emit(false));
    expect(world.files.cacheNames()).toContain(old);
    act(() => appState.emit(true));
    await waitFor(() => expect(world.files.cacheNames()).not.toContain(old));
    expect(world.files.cacheNames()).toContain(young);
  });

  it('on sign-out', async () => {
    const world = await createSignedInWorld({ startMs: START });
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    await screen.findByRole('heading', { name: 'Work list' });
    const old = seedArchive(world, 30 * MINUTE);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(world.files.cacheNames()).not.toContain(old));
  });

  it('when the device locks', async () => {
    const world = await createSignedInWorld({ startMs: START });
    const scheduler = fakeScheduler();
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} />);
    await screen.findByRole('heading', { name: 'Work list' });
    const old = seedArchive(world, 30 * MINUTE);
    world.clock.advance(31 * DAY_MS);
    await waitFor(() => expect(scheduler.active()).toBe(1));
    act(() => scheduler.tick());
    expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
    await waitFor(() => expect(world.files.cacheNames()).not.toContain(old));
  });

  it('when local data is cleared', async () => {
    const world = await createSignedInWorld({ startMs: START });
    world.clock.advance(31 * DAY_MS);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
    world.files.seedCache(exportFileName(world.clock.now() - 20 * MINUTE), null);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    await screen.findByRole('heading', { name: /sign in/i });
    await waitFor(() => expect(world.files.cacheNames()).toEqual([]));
  });
});
