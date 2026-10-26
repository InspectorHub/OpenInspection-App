// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { createOfflineStack, type OfflineStack } from './app/offline-stack';
import { createSignedInWorld, restartOffline, type World } from './app/test-support/world';
import type { StackFactory } from './app/use-offline-stack';
import { createFakePlugin } from './media/test-support/fakes';
import { createManualTimers } from './collab/test-support/manual-timers';
import { DAY_MS } from './offline/lock';
import { setRevoked } from './offline/lock-state';
import { fakeAppState, fakeScheduler } from './offline/test-support/fakes';
import { fakeNetwork } from './offline/test-support/replay-world';

configure({ asyncUtilTimeout: 5000 });

vi.mock('./ui/SignedIn', async () => {
  const { useOfflineStack } = await import('./app/stack-context');
  return {
    SignedIn: ({ onSignedOut }: { onSignedOut(): void }) => {
      const stack = useOfflineStack();
      return (
        <div>
          <span data-testid="stack-account">{stack ? `${stack.account.tenantId}/${stack.account.userId}` : 'none'}</span>
          <button type="button" onClick={onSignedOut}>
            leave
          </button>
        </div>
      );
    },
  };
});

afterEach(cleanup);

function rig(world: World) {
  const network = fakeNetwork(false);
  const timers = createManualTimers();
  const stacks: OfflineStack[] = [];
  const factory = vi.fn<StackFactory>(({ services, origin, identity, allowInsecureHttp, onUnlocked }) => {
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
    stacks.push(stack);
    return stack;
  });
  return { factory, stacks, network, timers };
}

/**
 * Waits for the signal that a stack was built (the screen shows its account, not the `none` the stub shows before), then for its start
 * sequence. The optional chain this replaces resolved at once while no stack existed, so the assertions after it ran too early.
 */
async function settledStack(stacks: OfflineStack[]): Promise<OfflineStack> {
  await waitFor(() => expect(screen.getByTestId('stack-account')).toHaveTextContent(/^tenant-[^/]+\/user-[^/]+$/));
  const stack = stacks[0];
  if (!stack) throw new Error('the factory did not build a stack');
  await stack.settled();
  return stack;
}

describe('the offline stack follows the signed-in screen', () => {
  it('builds one stack for a signed-in launch, starts it, and hands it to the work screen through context', async () => {
    const world = await createSignedInWorld();
    const { factory, stacks, network } = rig(world);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={factory} />);
    await waitFor(() => expect(screen.getByTestId('stack-account')).toHaveTextContent(/^tenant-[^/]+\/user-[^/]+$/));
    expect(factory).toHaveBeenCalledTimes(1);
    const input = factory.mock.calls[0]?.[0];
    expect(input?.origin).toBe(world.server.origin);
    await settledStack(stacks);
    expect(network.listeners()).toBeGreaterThan(0);
    expect(stacks[0]?.isStopped()).toBe(false);
  });

  it('builds none when no factory is given', async () => {
    const world = await createSignedInWorld();
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} />);
    expect(await screen.findByTestId('stack-account')).toHaveTextContent('none');
  });

  it('StrictMode runs the effects twice and still builds one stack, which stays alive', async () => {
    const world = await createSignedInWorld();
    const { factory, stacks } = rig(world);
    render(
      <StrictMode>
        <App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={factory} />
      </StrictMode>,
    );
    await settledStack(stacks);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(stacks[0]?.isStopped()).toBe(false);
  });

  it('sign-out stops it: no listener and no timer remains, and the sign-in screen holds none', async () => {
    const world = await createSignedInWorld();
    const { factory, stacks, network, timers } = rig(world);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={factory} />);
    await settledStack(stacks);
    expect(network.listeners()).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'leave' }));
    await screen.findByRole('heading', { name: /^Sign in/ });
    await waitFor(() => expect(stacks[0]?.isStopped()).toBe(true));
    expect(network.listeners()).toBe(0);
    expect(timers.pending()).toBe(0);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('a locked launch holds no stack', async () => {
    const world = await createSignedInWorld();
    world.clock.advance(31 * DAY_MS);
    const { factory } = rig(world);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={factory} />);
    await screen.findByRole('heading', { name: 'Verification needed' });
    expect(factory).not.toHaveBeenCalled();
  });

  it('a revoked launch holds no stack', async () => {
    const world = await createSignedInWorld();
    await setRevoked(world.db);
    const { factory } = rig(world);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={factory} />);
    await screen.findByText(/This data belongs to your company/);
    expect(factory).not.toHaveBeenCalled();
  });

  it('a lock that arrives mid-session stops the stack, and the unlock builds a new one', async () => {
    const world = await createSignedInWorld();
    const scheduler = fakeScheduler();
    const { factory, stacks, network, timers } = rig(world);
    render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={scheduler} appState={fakeAppState()} offline={factory} />);
    await settledStack(stacks);
    await waitFor(() => expect(scheduler.active()).toBe(1));

    const start = world.clock.now();
    world.clock.advance(31 * DAY_MS);
    act(() => scheduler.tick());
    await screen.findByRole('heading', { name: 'Verification needed' });
    await waitFor(() => expect(stacks[0]?.isStopped()).toBe(true));
    expect(network.listeners()).toBe(0);
    expect(timers.pending()).toBe(0);
    expect(factory).toHaveBeenCalledTimes(1);

    // Back inside the period (the server vouched for the device again): the next check lifts the lock.
    world.clock.set(start + 31 * DAY_MS);
    await world.db.run("INSERT OR REPLACE INTO device_state (key, value) VALUES ('last_verified_at', ?)", [String(world.clock.now())]);
    act(() => scheduler.tick());
    await waitFor(() => expect(screen.getByTestId('stack-account')).not.toHaveTextContent('none'));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(stacks[1]).not.toBe(stacks[0]);
    expect(stacks[1]?.isStopped()).toBe(false);
  });

  it('unmounting the app stops the stack', async () => {
    const world = await createSignedInWorld();
    const { factory, stacks, network } = rig(world);
    const view = render(<App open={() => Promise.resolve(restartOffline(world).services)} allowInsecureHttp={false} scheduler={fakeScheduler()} offline={factory} />);
    await settledStack(stacks);
    view.unmount();
    await waitFor(() => expect(stacks[0]?.isStopped()).toBe(true));
    expect(network.listeners()).toBe(0);
  });
});
