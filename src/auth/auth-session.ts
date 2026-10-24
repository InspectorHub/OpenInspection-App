import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { AuthError, type AuthErrorCode } from './errors';

export const CALLBACK_SCHEME = 'io.inspectorhub.app';
export const CALLBACK_PATH = '/oauth/callback';
/** The one redirect URI this app registers and the engine matches exactly. */
export const REDIRECT_URI = `${CALLBACK_SCHEME}:${CALLBACK_PATH}`;

/** How long one sign-in may wait for its callback before it is abandoned. */
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;

/** Opens the system sign-in page and returns the URL the server redirected back to. */
export interface AuthSession {
  /**
   * Resolves with the callback URL. Rejects `sign_in_cancelled` after `cancel()`,
   * `sign_in_expired` when no callback arrives within the time limit, and
   * `sign_in_in_progress` when a login is already waiting. A callback URL that `accept` refuses
   * (including one with a missing, repeated or mismatched `state`) is ignored as if it had never
   * arrived, not reported as an error: the login keeps waiting and the browser stays open until a
   * genuine callback, `cancel()` or the time limit ends it. Dismissing the tab alone does not end the
   * login, so the UI must offer a cancel affordance that calls `cancel()` (`LoginFlow.cancel()`).
   */
  start(url: string, callbackScheme: string, accept?: (callbackUrl: string) => boolean): Promise<string>;
  /** Ends the waiting login as cancelled and closes the browser. No effect when nothing is waiting. */
  cancel(): void;
  /**
   * Called when the browser reports that it finished. That is a hint, not a verdict: the callback
   * may still be on its way, or the report may be spurious. The login stays alive; the UI decides
   * whether to offer a cancel. Returns an unsubscribe function.
   */
  onBrowserClosed(listener: () => void): () => void;
}

/**
 * The query of `raw` when it is exactly the callback (the private scheme, no
 * authority, the exact path), otherwise null. Everything else is not ours.
 */
export function parseCallbackUrl(raw: string, scheme: string = CALLBACK_SCHEME): URLSearchParams | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.host !== '' || url.username || url.password || url.pathname !== CALLBACK_PATH) return null;
  return url.searchParams;
}

export function isCallbackUrl(raw: string, scheme: string): boolean {
  return parseCallbackUrl(raw, scheme) !== null;
}

interface ListenerHandle {
  remove(): Promise<void>;
}

/** The part of the Browser plugin the session uses. */
export interface BrowserLike {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
  addListener(event: 'browserFinished', listener: () => void): Promise<ListenerHandle>;
}

/** The part of the App plugin the session uses. */
export interface AppLike {
  addListener(event: 'appUrlOpen', listener: (event: { url: string }) => void): Promise<ListenerHandle>;
}

export interface AndroidAuthSessionDeps {
  browser: BrowserLike;
  app: AppLike;
  /** Overall time limit for one login; defaults to `PENDING_LOGIN_TTL_MS`. */
  timeoutMs?: number;
}

interface PendingStart {
  scheme: string;
  accept: ((callbackUrl: string) => boolean) | undefined;
  resolve(url: string): void;
  reject(error: AuthError): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** True once this login's own tab has been opened; a browser report before that is about an older tab. */
  tabOpened: boolean;
}

function isWebUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * RFC 8252 on Android: the sign-in page opens in a Custom Tab (never a
 * WebView) and the private-scheme redirect comes back as an `appUrlOpen`
 * event. One listener is registered for the life of the session object, and
 * it ignores every URL that is not exactly the callback.
 *
 * `browserFinished` is deliberately not treated as a cancellation. In
 * @capacitor/browser 8 it fires when the Custom Tab activity returns its
 * result, and on Android below 14 also when the tab is minimized to
 * picture-in-picture while it is still alive. A login ends only by a callback,
 * an explicit `cancel()`, or the overall time limit.
 */
export function createAndroidAuthSession(deps: AndroidAuthSessionDeps): AuthSession {
  const timeoutMs = deps.timeoutMs ?? PENDING_LOGIN_TTL_MS;
  const closedListeners = new Set<() => void>();
  let pending: PendingStart | null = null;
  /** Each plugin registration is tracked on its own, so a retry repeats only the one that failed. */
  let appRegistration: Promise<unknown> | null = null;
  let browserRegistration: Promise<unknown> | null = null;

  /** Best effort, and safe against a plugin that throws or returns something that is not a promise. */
  function closeBrowser(): Promise<void> {
    return Promise.resolve()
      .then(() => deps.browser.close())
      .catch(() => undefined);
  }

  function settle(p: PendingStart): void {
    clearTimeout(p.timer);
    if (pending === p) pending = null;
  }

  function end(p: PendingStart, code: AuthErrorCode): void {
    if (pending !== p) return;
    settle(p);
    closeBrowser();
    p.reject(new AuthError(code));
  }

  function ensureListeners(): Promise<unknown> {
    if (!appRegistration) {
      const registration = deps.app.addListener('appUrlOpen', ({ url }) => {
        const p = pending;
        if (!p || !isCallbackUrl(url, p.scheme) || (p.accept && !p.accept(url))) return;
        settle(p);
        closeBrowser();
        p.resolve(url);
      });
      appRegistration = registration;
      registration.catch(() => {
        if (appRegistration === registration) appRegistration = null;
      });
    }
    if (!browserRegistration) {
      const registration = deps.browser.addListener('browserFinished', () => {
        if (!pending?.tabOpened) return;
        for (const listener of [...closedListeners]) {
          try {
            listener();
          } catch {
            // A faulty listener is unsubscribed so it cannot fail every later report, and the error is
            // dropped: it belongs to the UI, and the plugin dispatch must not see it.
            closedListeners.delete(listener);
          }
        }
      });
      browserRegistration = registration;
      registration.catch(() => {
        if (browserRegistration === registration) browserRegistration = null;
      });
    }
    return Promise.all([appRegistration, browserRegistration]);
  }

  return {
    start: (url, callbackScheme, accept) => {
      if (pending) return Promise.reject(new AuthError('sign_in_in_progress'));
      if (!isWebUrl(url)) return Promise.reject(new AuthError('sign_in_failed'));
      return new Promise<string>((resolve, reject) => {
        const p: PendingStart = { scheme: callbackScheme, accept, resolve, reject, timer: undefined, tabOpened: false };
        pending = p;
        p.timer = setTimeout(() => {
          end(p, 'sign_in_expired');
        }, timeoutMs);
        ensureListeners()
          .then(async () => {
            // A cancel or the time limit may have ended this login while the listeners were registering.
            if (pending !== p) return;
            // A tab left over from an earlier login (cancelled, or from a previous run of the app) must not
            // stay on the stack under the new one. Best effort: there may be nothing to close.
            await closeBrowser();
            if (pending !== p) return;
            await deps.browser.open({ url });
            p.tabOpened = true;
            // ...or while the tab was opening, when the close that ended it ran before the tab existed.
            if (pending !== p) void closeBrowser();
          })
          .catch(() => {
            if (pending !== p) return;
            settle(p);
            reject(new AuthError('sign_in_failed'));
          });
      });
    },
    cancel: () => {
      if (pending) end(pending, 'sign_in_cancelled');
    },
    onBrowserClosed: (listener) => {
      closedListeners.add(listener);
      return () => {
        closedListeners.delete(listener);
      };
    },
  };
}

/** Thin real-plugin wiring for Android; the behaviour above is what the tests cover. */
export function createCapacitorAuthSession(): AuthSession {
  return createAndroidAuthSession({ browser: Browser, app: App });
}
