import { describe, expect, it, vi } from 'vitest';
import { createHeldAuthSession, createWorld } from './test-support/world';
import { registerCallbackRouter } from './callbacks';
import type { AppLike } from '../auth/auth-session';
import { connectToServer } from './connect';

function fakeApp(): AppLike & { emit(url: string): void; registrations: number } {
  const listeners: ((event: { url: string }) => void)[] = [];
  const app = {
    registrations: 0,
    addListener: (_event: 'appUrlOpen', listener: (event: { url: string }) => void) => {
      app.registrations += 1;
      listeners.push(listener);
      return Promise.resolve({ remove: () => Promise.resolve() });
    },
    emit: (url: string) => {
      for (const listener of listeners) listener({ url });
    },
  };
  return app;
}

const STRAY = 'io.inspectorhub.app:/oauth/callback?code=abc&state=stray';

describe('callback router', () => {
  it('registers the appUrlOpen listener once, before any flow is bound', () => {
    const app = fakeApp();
    registerCallbackRouter(app);
    expect(app.registrations).toBe(1);
  });

  it('a callback that arrives with no flow bound, or no login waiting, is ignored without a network call or a throw', async () => {
    const app = fakeApp();
    const router = registerCallbackRouter(app);
    expect(() => app.emit(STRAY)).not.toThrow();
    const world = await createWorld();
    router.bind(world.services.flow);
    expect(() => app.emit(STRAY)).not.toThrow();
    await Promise.resolve();
    expect(world.fetched).toEqual([]);
    expect(world.services.flow.hasPending()).toBe(false);
  });

  it('hostile URLs are ignored: other schemes, paths, authorities, and non-strings', async () => {
    const app = fakeApp();
    const router = registerCallbackRouter(app);
    const world = await createWorld({ authSession: (server) => createHeldAuthSession(server) });
    router.bind(world.services.flow);
    const hostile = ['https://evil.example.test/oauth/callback?code=x&state=y', 'evil:/oauth/callback?code=x', 'io.inspectorhub.app://evil/oauth/callback?code=x', 'io.inspectorhub.app:/other?code=x', '', 'not a url', 'javascript:alert(1)'];
    for (const url of hostile) expect(() => app.emit(url), url).not.toThrow();
    expect(() => app.emit(undefined as unknown as string)).not.toThrow();
    await Promise.resolve();
    expect(world.fetched).toEqual([]);
  });

  it('a callback for the waiting login reaches the flow and completes the sign-in', async () => {
    const app = fakeApp();
    const router = registerCallbackRouter(app);
    let authorizeUrl = '';
    const world = await createWorld({
      authSession: () => ({
        start: (url) => {
          authorizeUrl = url;
          return new Promise<string>(() => undefined);
        },
        cancel: () => undefined,
        onBrowserClosed: () => () => undefined,
      }),
    });
    router.bind(world.services.flow);
    await connectToServer(world.services, world.server.origin);
    const signedIn = world.services.flow.signIn(world.server.origin);
    for (let i = 0; i < 50 && authorizeUrl === ''; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(authorizeUrl).not.toBe('');
    app.emit(await world.server.authorize(authorizeUrl));
    await expect(signedIn).resolves.toMatchObject({ origin: world.server.origin });
  });

  it('unbinding stops routing, and a throwing flow does not escape into the plugin dispatch', () => {
    const app = fakeApp();
    const router = registerCallbackRouter(app);
    const handleCallback = vi.fn(() => {
      throw new Error('boom');
    });
    const unbind = router.bind({ handleCallback });
    expect(() => app.emit(STRAY)).not.toThrow();
    expect(handleCallback).toHaveBeenCalledTimes(1);
    unbind();
    app.emit(STRAY);
    expect(handleCallback).toHaveBeenCalledTimes(1);
  });

  it('never logs the callback URL', () => {
    const app = fakeApp();
    const router = registerCallbackRouter(app);
    router.bind({ handleCallback: () => Promise.reject(new Error('rejected')) });
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    app.emit(STRAY);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
