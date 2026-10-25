// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, configure, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { composeWith, type AppServices } from './app/compose';
import { createSignedInWorld, type World } from './app/test-support/world';
import { fakeAppState, fakeScheduler } from './offline/test-support/fakes';

configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);

const COMPAT = (over: Record<string, unknown>) =>
  new Response(JSON.stringify({ success: true, data: { minSupported: null, recommended: null, downloadUrl: null, serverContractVersion: 2, ...over } }), { status: 200, headers: { 'content-type': 'application/json' } });

/** The signed-in device again, on a network whose compat answer the test chooses. */
function restart(world: World, answer: { current: () => Response | null }): { services: AppServices; compatCalls: () => number } {
  let calls = 0;
  const services = composeWith({
    db: world.db,
    files: world.files,
    store: world.store,
    fetch: (input) => {
      if (input.includes('/api/client/compat')) {
        calls += 1;
        const response = answer.current();
        if (response) return Promise.resolve(response);
      }
      return Promise.reject(new TypeError('network down'));
    },
    authSession: world.server.authSession,
    clock: world.clock,
    platform: 'android',
    appVersion: '1.0.0',
  });
  return { services, compatCalls: () => calls };
}

describe('the app looks at the server again when it returns to the foreground', () => {
  it('a foreground return asks for compat once and shows what it learned; no timer is involved', async () => {
    const world = await createSignedInWorld();
    let reply: Response | null = null;
    const { services, compatCalls } = restart(world, { current: () => reply });
    const appState = fakeAppState();
    render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} scheduler={fakeScheduler()} appState={appState} />);
    expect(await screen.findByRole('heading', { name: 'Work list' })).toBeInTheDocument();
    await waitFor(() => expect(appState.listeners()).toBeGreaterThan(0));
    expect(compatCalls()).toBe(0);

    reply = COMPAT({ minSupported: '9.0.0' });
    act(() => appState.emit(true));
    expect(await screen.findByRole('heading', { name: 'Update required' })).toBeInTheDocument();
    expect(compatCalls()).toBe(1);
  });

  it('going to the background asks for nothing (control beside the case above)', async () => {
    const world = await createSignedInWorld();
    const { services, compatCalls } = restart(world, { current: () => COMPAT({}) });
    const appState = fakeAppState();
    render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} scheduler={fakeScheduler()} appState={appState} />);
    await screen.findByRole('heading', { name: 'Work list' });
    await waitFor(() => expect(appState.listeners()).toBeGreaterThan(0));
    act(() => appState.emit(false));
    await act(async () => {
      for (let i = 0; i < 100; i += 1) await Promise.resolve();
    });
    expect(compatCalls()).toBe(0);
  });

  it('an unreachable server on return changes nothing on screen and shows no error', async () => {
    const world = await createSignedInWorld();
    const { services, compatCalls } = restart(world, { current: () => null });
    const appState = fakeAppState();
    render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} scheduler={fakeScheduler()} appState={appState} />);
    await screen.findByRole('heading', { name: 'Work list' });
    await waitFor(() => expect(appState.listeners()).toBeGreaterThan(0));
    act(() => appState.emit(true));
    await waitFor(() => expect(compatCalls()).toBe(1));
    await act(async () => {
      for (let i = 0; i < 100; i += 1) await Promise.resolve();
    });
    expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the listener is gone once the signed-in screen is', async () => {
    const world = await createSignedInWorld();
    const { services } = restart(world, { current: () => COMPAT({}) });
    const appState = fakeAppState();
    const view = render(<App open={() => Promise.resolve(services)} allowInsecureHttp={false} scheduler={fakeScheduler()} appState={appState} />);
    await screen.findByRole('heading', { name: 'Work list' });
    view.unmount();
    expect(appState.listeners()).toBe(0);
  });
});
