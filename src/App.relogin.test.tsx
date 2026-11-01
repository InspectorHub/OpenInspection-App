// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createOfflineStack, type OfflineStack } from './app/offline-stack';
import { createHeldAuthSession, createSignedInWorld, rowCounts, seedLocalData, type HeldAuthSession, type World } from './app/test-support/world';
import type { StackFactory } from './app/use-offline-stack';
import { createManualTimers } from './collab/test-support/manual-timers';
import { createFakePlugin } from './media/test-support/fakes';
import { fakeScheduler } from './offline/test-support/fakes';
import { fakeNetwork } from './offline/test-support/replay-world';
import { withStatus } from './ui/test-support/worklist-render';

configure({ asyncUtilTimeout: 5000 });

let scrollTo: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollTo = vi.fn();
  vi.spyOn(window, 'scrollTo').mockImplementation(scrollTo as unknown as typeof window.scrollTo);
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const DATA_TABLES = ['ydoc_updates', 'media', 'outbox', 'resource_cache', 'work_package'];

/** A real offline stack whose status says the sign-in was lost (or not). */
function factoryFor(world: World, auth: boolean): StackFactory {
  const network = fakeNetwork(false);
  const timers = createManualTimers();
  return ({ services, origin, identity, allowInsecureHttp, onUnlocked }): OfflineStack => {
    const stack = createOfflineStack({
      db: services.db,
      files: services.files,
      http: services.http,
      tokens: services.tokens,
      origin,
      identity,
      clientHeaders: { 'X-Client-Platform': services.platform },
      clock: services.clock,
      network,
      uploaderPlugin: createFakePlugin({ files: world.files }),
      openSocket: () => ({ isOpen: () => false, send: () => undefined, close: () => undefined }),
      allowInsecureHttp,
      timers,
      onUnlocked,
      onTokenVerified: services.onTokenVerified,
    });
    return withStatus(stack, { auth }).stack;
  };
}

async function dataRows(world: World): Promise<number[]> {
  const counts = await rowCounts(world.db);
  return DATA_TABLES.map((table) => counts[table] ?? -1);
}

async function open(auth: boolean, held?: { session?: HeldAuthSession }): Promise<World> {
  let created: Promise<World>;
  if (held === undefined) created = createSignedInWorld();
  else {
    // The held sign-in page stays open until approved, and signing the world in opens one: approve that first one here.
    created = createSignedInWorld({
      authSession: (server) => {
        held.session = createHeldAuthSession(server);
        return held.session;
      },
    });
    await vi.waitFor(() => expect(held.session?.opened).toBe(1));
    await held.session?.approve();
  }
  const world = await created;
  await seedLocalData(world.db);
  render(<App open={() => Promise.resolve(world.services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={factoryFor(world, auth)} />);
  await screen.findByRole('heading', { name: 'Work list' });
  return world;
}

describe('signing in again from the work list when the session was lost', () => {
  it('the button opens the relogin screen, and Back returns to the work list with the data kept', async () => {
    const world = await open(true);
    const before = await dataRows(world);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByRole('heading', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.getByText(/saved on this device are kept/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Work list' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    // The work list is rebuilt once its stack is back, so wait for the screen to settle on the button rather than on the first heading.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Work list' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
    });
    expect(await dataRows(world)).toEqual(before);
  });

  it('control: signed in normally the work list has no Sign in again button', async () => {
    await open(false);
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();
  });

  it('the list comes back to where it was scrolled to: restored once, after the work list is ready again', async () => {
    await open(true);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await screen.findByRole('heading', { name: 'Sign in again' });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument());
    await waitFor(() => expect(scrollTo.mock.calls.filter(([, y]) => y === 300)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scrollTo.mock.calls.filter(([, y]) => y === 300)).toHaveLength(1);
  });

  it('control: a list at the top is not scrolled on the way back', async () => {
    await open(true);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('after signing out and signing in again, the list does not restore the previous position', async () => {
    const held: { session?: HeldAuthSession } = {};
    await open(true, held);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    const user = userEvent.setup();
    // The round trip through the sign-in screen keeps the position in the shared memory and restores it, as it should.
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await user.click(await screen.findByRole('button', { name: 'Back' }));
    await waitFor(() => expect(scrollTo.mock.calls.filter(([, y]) => y === 300)).toHaveLength(1));
    scrollTo.mockClear();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held.session?.opened).toBeGreaterThan(0));
    await act(async () => {
      await held.session?.approve();
    });
    await screen.findByRole('heading', { name: 'Work list' });
    await screen.findByText('Not updated yet');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scrollTo.mock.calls.filter(([, y]) => y === 300)).toHaveLength(0);
  });

  it('after choosing a different server and signing in, the list does not restore the previous position', async () => {
    const held: { session?: HeldAuthSession } = {};
    const world = await open(true, held);
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 300 });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Sign in again' }));
    await user.click(await screen.findByRole('button', { name: 'Use a different server' }));
    const input = await screen.findByLabelText('Server address');
    await user.clear(input);
    await user.type(input, world.server.origin);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    await vi.waitFor(() => expect(held.session?.opened).toBeGreaterThan(0));
    await act(async () => {
      await held.session?.approve();
    });
    await screen.findByRole('heading', { name: 'Work list' });
    await screen.findByText('Not updated yet');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(scrollTo.mock.calls.filter(([, y]) => y === 300)).toHaveLength(0);
  });
});
