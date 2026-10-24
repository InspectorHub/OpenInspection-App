import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAndroidAuthSession, isCallbackUrl, type AppLike, type BrowserLike } from './auth-session';
import { isAuthError } from './errors';

const SCHEME = 'io.inspectorhub.app';
const AUTH_URL = 'https://oi.example.test/oauth/authorize?x=1';
const CALLBACK = 'io.inspectorhub.app:/oauth/callback?code=c&state=s';

interface Fakes {
  browser: BrowserLike & { opened: string[]; closed: number; finish(): void };
  app: AppLike & { listeners: number; open(url: string): void };
}

function fakes(options: { openFails?: boolean; browserListenerFailsOnce?: boolean } = {}): Fakes {
  let browserListenerFailures = options.browserListenerFailsOnce ? 1 : 0;
  const finishedListeners = new Set<() => void>();
  const urlListeners = new Set<(e: { url: string }) => void>();
  const browser = {
    opened: [] as string[],
    closed: 0,
    open: (o: { url: string }) => {
      if (options.openFails) return Promise.reject(new Error('no browser'));
      browser.opened.push(o.url);
      return Promise.resolve();
    },
    close: () => {
      browser.closed += 1;
      return Promise.resolve();
    },
    addListener: (_event: 'browserFinished', cb: () => void) => {
      if (browserListenerFailures > 0) {
        browserListenerFailures -= 1;
        return Promise.reject(new Error('plugin not ready'));
      }
      finishedListeners.add(cb);
      return Promise.resolve({ remove: () => Promise.resolve(void finishedListeners.delete(cb)) });
    },
    finish: () => {
      for (const cb of [...finishedListeners]) cb();
    },
  };
  const app = {
    get listeners() {
      return urlListeners.size;
    },
    addListener: (_event: 'appUrlOpen', cb: (e: { url: string }) => void) => {
      urlListeners.add(cb);
      return Promise.resolve({ remove: () => Promise.resolve(void urlListeners.delete(cb)) });
    },
    open: (url: string) => {
      for (const cb of [...urlListeners]) cb({ url });
    },
  };
  return { browser, app };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (isAuthError(err)) return err.code;
    throw err;
  }
  return 'resolved';
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isCallbackUrl', () => {
  it('accepts exactly the registered callback and nothing else', () => {
    expect(isCallbackUrl(CALLBACK, SCHEME)).toBe(true);
    expect(isCallbackUrl('io.inspectorhub.app:/oauth/callback', SCHEME)).toBe(true);
    for (const bad of ['io.inspectorhub.app:/oauth/other', 'io.inspectorhub.app://oauth/callback', 'evil:/oauth/callback', 'https://x.test/oauth/callback', '']) {
      expect(isCallbackUrl(bad, SCHEME), bad).toBe(false);
    }
  });
});

describe('Android auth session (Custom Tab)', () => {
  it('opens the URL in the browser plugin and resolves with the callback, closing the tab', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    const pending = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.browser.opened).toEqual([AUTH_URL]);
    f.app.open(CALLBACK);
    expect(await pending).toBe(CALLBACK);
    expect(f.browser.closed).toBe(1);
  });

  it('ignores any other URL and keeps waiting', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    const pending = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    f.app.open('io.inspectorhub.app:/oauth/other?code=evil');
    f.app.open('https://evil.example.test/oauth/callback?code=evil');
    f.app.open('io.inspectorhub.app://oauth/callback?code=evil');
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    f.app.open(CALLBACK);
    expect(await pending).toBe(CALLBACK);
  });

  it('registers the appUrlOpen listener once however many logins happen', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    for (let i = 0; i < 3; i += 1) {
      const p = session.start(AUTH_URL, SCHEME);
      await vi.advanceTimersByTimeAsync(0);
      f.app.open(CALLBACK);
      await p;
    }
    expect(f.app.listeners).toBe(1);
  });

  it('does not cancel when the tab reports finished: it tells listeners and keeps waiting, so a late callback still wins', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    let closedSignals = 0;
    session.onBrowserClosed(() => {
      closedSignals += 1;
    });
    const pending = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    f.browser.finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closedSignals).toBe(1);
    f.app.open(CALLBACK);
    expect(await pending).toBe(CALLBACK);
  });

  it('cancel() rejects the waiting login as cancelled, closes the tab, and a new login then works', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    const pending = session.start(AUTH_URL, SCHEME);
    const outcome = codeOf(pending);
    await vi.advanceTimersByTimeAsync(0);
    session.cancel();
    expect(await outcome).toBe('sign_in_cancelled');
    expect(f.browser.closed).toBe(1);
    f.app.open(CALLBACK);
    const again = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    f.app.open(CALLBACK);
    expect(await again).toBe(CALLBACK);
  });

  it('cancel() with nothing waiting does nothing', () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    expect(() => session.cancel()).not.toThrow();
    expect(f.browser.closed).toBe(0);
  });

  it('onBrowserClosed returns an unsubscribe that stops the signals', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    let signals = 0;
    const off = session.onBrowserClosed(() => {
      signals += 1;
    });
    const pending = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    off();
    f.browser.finish();
    expect(signals).toBe(0);
    f.app.open(CALLBACK);
    await pending;
  });

  it('gives up with sign_in_expired when neither the callback nor a close ever arrives, and clears everything', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app, timeoutMs: 10_000 });
    const pending = session.start(AUTH_URL, SCHEME);
    const outcome = codeOf(pending);
    await vi.advanceTimersByTimeAsync(9_999);
    f.browser.finish();
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe('sign_in_expired');
    expect(f.browser.closed).toBe(1);
    expect(() => f.app.open(CALLBACK)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('after an expiry a later login works and is not hit by the old timer', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app, timeoutMs: 10_000 });
    const first = codeOf(session.start(AUTH_URL, SCHEME));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await first).toBe('sign_in_expired');
    const second = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(9_000);
    f.app.open(CALLBACK);
    expect(await second).toBe(CALLBACK);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a callback that arrives when no login is waiting', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    const first = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    f.app.open(CALLBACK);
    await first;
    expect(() => f.app.open(CALLBACK)).not.toThrow();
    const second = session.start(AUTH_URL, SCHEME);
    const outcome = codeOf(second);
    await vi.advanceTimersByTimeAsync(0);
    session.cancel();
    expect(await outcome).toBe('sign_in_cancelled');
  });

  it('refuses a second start while one is waiting', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    const first = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    expect(await codeOf(session.start(AUTH_URL, SCHEME))).toBe('sign_in_in_progress');
    f.app.open(CALLBACK);
    await first;
  });

  it('fails cleanly when the browser cannot be opened, and can be used again', async () => {
    const f = fakes({ openFails: true });
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    expect(await codeOf(session.start(AUTH_URL, SCHEME))).toBe('sign_in_failed');
    expect(await codeOf(session.start(AUTH_URL, SCHEME))).toBe('sign_in_failed');
  });

  it('a throwing browser-closed listener does not skip later listeners and does not propagate into the plugin dispatch', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    let later = 0;
    session.onBrowserClosed(() => {
      throw new Error('listener bug');
    });
    session.onBrowserClosed(() => {
      later += 1;
    });
    const pending = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    expect(() => f.browser.finish()).not.toThrow();
    expect(later).toBe(1);
    expect(() => f.browser.finish()).not.toThrow();
    expect(later).toBe(2);
    f.app.open(CALLBACK);
    await pending;
  });

  it('does not register appUrlOpen twice when the browser listener failed after the app listener succeeded', async () => {
    const f = fakes({ browserListenerFailsOnce: true });
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    expect(await codeOf(session.start(AUTH_URL, SCHEME))).toBe('sign_in_failed');
    const again = session.start(AUTH_URL, SCHEME);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.app.listeners).toBe(1);
    f.app.open(CALLBACK);
    expect(await again).toBe(CALLBACK);
  });

  it('ignores a callback the accept predicate refuses and keeps waiting for one it accepts', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    const genuine = 'io.inspectorhub.app:/oauth/callback?code=c&state=good';
    const pending = session.start(AUTH_URL, SCHEME, (url) => url.includes('state=good'));
    await vi.advanceTimersByTimeAsync(0);
    f.app.open('io.inspectorhub.app:/oauth/callback?code=evil&state=bad');
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(settled).toBe(false);
    expect(f.browser.closed).toBe(0);
    f.app.open(genuine);
    expect(await pending).toBe(genuine);
  });

  it('only opens http and https URLs', async () => {
    const f = fakes();
    const session = createAndroidAuthSession({ browser: f.browser, app: f.app });
    expect(await codeOf(session.start('javascript:alert(1)', SCHEME))).toBe('sign_in_failed');
    expect(await codeOf(session.start('file:///etc/passwd', SCHEME))).toBe('sign_in_failed');
    expect(f.browser.opened).toEqual([]);
  });
});
