// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createSignedInWorld, restartOffline, rowCounts, seedLocalData } from './app/test-support/world';
import { DAY_MS } from './offline/lock';
import { evaluateAndPersist, setRevoked } from './offline/lock-state';
import { fakeAppState, fakeScheduler } from './offline/test-support/fakes';

afterEach(cleanup);

const WORK_HEADING = 'Work list coming in a later task';
const START = 9_000_000;

describe('boot decides the lock before the signed-in screen', () => {
  it('past the offline period: the locked screen, never the work screen, and no request', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    world.clock.advance(31 * DAY_MS);
    const { services, calls } = restartOffline(world);
    render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
    expect(await screen.findByTestId('waiting-count')).toHaveTextContent('2 items waiting to upload');
    expect(calls).toEqual([]);
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('control: inside the period the same device opens on the work screen', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(29 * DAY_MS);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    expect(await screen.findByRole('heading', { name: WORK_HEADING })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Verification needed' })).toBeNull();
  });

  it('a wound-back clock: the date and time screen', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    expect(await screen.findByRole('heading', { name: 'Check your date and time' })).toBeInTheDocument();
  });

  it('a revoked device: the revoked text and no verify button', async () => {
    const world = await createSignedInWorld();
    await setRevoked(world.db);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    expect(await screen.findByText(/This data belongs to your company/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify online' })).toBeNull();
  });
});

describe('the lock is decided again while the app is open', () => {
  it('the 60 second check replaces the work screen with the locked screen', async () => {
    const world = await createSignedInWorld();
    const scheduler = fakeScheduler();
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} />);
    await screen.findByRole('heading', { name: WORK_HEADING });
    world.clock.advance(31 * DAY_MS);
    act(() => scheduler.tick());
    expect(await screen.findByRole('heading', { name: 'Verification needed' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
  });

  it('returning to the foreground does the same, with the wound-back clock as the reason', async () => {
    const world = await createSignedInWorld();
    const appState = fakeAppState();
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} appState={appState} />);
    await screen.findByRole('heading', { name: WORK_HEADING });
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START);
    act(() => appState.emit(true));
    expect(await screen.findByRole('heading', { name: 'Check your date and time' })).toBeInTheDocument();
  });

  it('once the clock is corrected the next check returns to the work screen', async () => {
    const world = await createSignedInWorld();
    const scheduler = fakeScheduler();
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} />);
    await screen.findByRole('heading', { name: 'Check your date and time' });
    world.clock.set(START + DAY_MS + 60_000);
    act(() => scheduler.tick());
    expect(await screen.findByRole('heading', { name: WORK_HEADING })).toBeInTheDocument();
  });

  it('the interval is torn down when the app unmounts', async () => {
    const world = await createSignedInWorld();
    const scheduler = fakeScheduler();
    const view = render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} />);
    await screen.findByRole('heading', { name: WORK_HEADING });
    expect(scheduler.active()).toBe(1);
    view.unmount();
    expect(scheduler.active()).toBe(0);
  });

  it('control: with no screen to protect (server setup) no check is scheduled', async () => {
    const world = await createSignedInWorld();
    await world.db.run("DELETE FROM device_state WHERE key = 'server_url'");
    const scheduler = fakeScheduler();
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} />);
    await screen.findByRole('heading', { name: 'Choose your server' });
    expect(scheduler.active()).toBe(0);
  });
});

describe('leaving the locked screen', () => {
  it('Verify online brings an expired device back to the work screen', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Verify online' }));
    expect(await screen.findByRole('heading', { name: WORK_HEADING })).toBeInTheDocument();
  });

  it('Verify online with a clock still behind stays locked', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(DAY_MS);
    await evaluateAndPersist(world.db, world.clock.now());
    world.clock.set(START);
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Verify online' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/still earlier than the app has already seen/i);
    expect(screen.getByRole('heading', { name: 'Check your date and time' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: WORK_HEADING })).toBeNull();
  });

  it('a refused session goes to the sign-in screen with the data kept', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    const before = await rowCounts(world.db);
    world.clock.advance(31 * DAY_MS);
    world.server.revokeAllGrants();
    render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify online' }));
    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeInTheDocument();
    expect(await rowCounts(world.db)).toEqual(before);
  });

  it('clearing local data returns to sign-in for the same server', async () => {
    const world = await createSignedInWorld();
    await seedLocalData(world.db);
    await world.files.write('/p', new Uint8Array([1]));
    await setRevoked(world.db);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Clear local data' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear local data' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByTestId('server-origin')).toHaveTextContent(world.server.origin);
    await waitFor(async () => expect((await rowCounts(world.db)).outbox).toBe(0));
  });
});
