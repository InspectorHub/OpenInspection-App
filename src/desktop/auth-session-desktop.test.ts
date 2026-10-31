import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopAppLike, createDesktopAuthSession } from './auth-session-desktop.ts';

const AUTH_URL = 'https://engine.example.test/oauth/authorize';
const CALLBACK = 'io.inspectorhub.app:/oauth/callback?code=secret&state=ok';

function bridge() {
  const callbacks = new Set<(url: string) => void>();
  const opened: string[] = [];
  return {
    shell: {
      openExternal: async (url: string) => { opened.push(url); },
      openLogs: async () => {},
      openDataFolder: async () => {},
    },
    auth: { onCallback: (listener: (url: string) => void) => { callbacks.add(listener); return () => { callbacks.delete(listener); }; } },
    callbacks,
    opened,
    callback: (url: string) => { for (const listener of [...callbacks]) listener(url); },
  };
}

afterEach(() => vi.useRealTimers());

describe('desktop auth session', () => {
  it('opens the system browser and resolves the accepted callback without a close signal', async () => {
    const b = bridge();
    const session = createDesktopAuthSession(b);
    let browserClosed = 0;
    session.onBrowserClosed(() => { browserClosed += 1; });
    const pending = session.start(AUTH_URL, 'io.inspectorhub.app', (url) => url.includes('state=ok'));
    await vi.waitFor(() => expect(b.opened).toEqual([AUTH_URL]));
    b.callback(CALLBACK.replace('state=ok', 'state=wrong'));
    b.callback(CALLBACK);
    await expect(pending).resolves.toBe(CALLBACK);
    expect(browserClosed).toBe(0);
  });

  it('keeps rejecting overlapping starts, permits cancel, and reports sign_in_cancelled', async () => {
    const b = bridge();
    const session = createDesktopAuthSession(b);
    const first = session.start(AUTH_URL, 'io.inspectorhub.app');
    await expect(session.start(AUTH_URL, 'io.inspectorhub.app')).rejects.toMatchObject({ code: 'sign_in_in_progress' });
    session.cancel();
    await expect(first).rejects.toMatchObject({ code: 'sign_in_cancelled' });
  });

  it('expires an unanswered system browser session', async () => {
    vi.useFakeTimers();
    const b = bridge();
    const session = createDesktopAuthSession(b, { timeoutMs: 25 });
    const pending = session.start(AUTH_URL, 'io.inspectorhub.app');
    const result = expect(pending).rejects.toMatchObject({ code: 'sign_in_expired' });
    await vi.advanceTimersByTimeAsync(25);
    await result;
  });

  it('adapts desktop callbacks to appUrlOpen events and unsubscribes them', async () => {
    const b = bridge();
    const app = createDesktopAppLike(b);
    const seen: string[] = [];
    const remove = app.addListener('appUrlOpen', ({ url }) => seen.push(url));
    b.callback(CALLBACK);
    expect(seen).toEqual([CALLBACK]);
    await (await remove).remove();
    b.callback('io.inspectorhub.app:/oauth/callback?code=next&state=s');
    expect(seen).toEqual([CALLBACK]);
  });
});
