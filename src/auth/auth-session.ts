import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { AuthError, type AuthErrorCode } from './errors';

export const CALLBACK_SCHEME = 'io.inspectorhub.app';
export const CALLBACK_PATH = '/oauth/callback';
/** The one redirect URI this app registers and the engine matches exactly. */
export const REDIRECT_URI = `${CALLBACK_SCHEME}:${CALLBACK_PATH}`;

/** Opens the system sign-in page and returns the URL the server redirected back to. */
export interface AuthSession {
  start(url: string, callbackScheme: string): Promise<string>;
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
  /**
   * The Custom Tab reports "finished" both when the user closes it and (on some
   * devices) just before the callback intent arrives. A callback within this
   * window still wins; after it, the tab closing means the user gave up.
   */
  dismissGraceMs?: number;
}

const DEFAULT_DISMISS_GRACE_MS = 700;

interface PendingStart {
  scheme: string;
  resolve(url: string): void;
  reject(error: AuthError): void;
  graceTimer: ReturnType<typeof setTimeout> | undefined;
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
 */
export function createAndroidAuthSession(deps: AndroidAuthSessionDeps): AuthSession {
  const grace = deps.dismissGraceMs ?? DEFAULT_DISMISS_GRACE_MS;
  let pending: PendingStart | null = null;
  let listening: Promise<void> | null = null;

  function settle(p: PendingStart): void {
    clearTimeout(p.graceTimer);
    if (pending === p) pending = null;
  }

  function ensureListeners(): Promise<void> {
    if (!listening) {
      listening = (async () => {
        await deps.app.addListener('appUrlOpen', ({ url }) => {
          const p = pending;
          if (!p || !isCallbackUrl(url, p.scheme)) return;
          settle(p);
          deps.browser.close().catch(() => undefined);
          p.resolve(url);
        });
        await deps.browser.addListener('browserFinished', () => {
          const p = pending;
          if (!p) return;
          clearTimeout(p.graceTimer);
          p.graceTimer = setTimeout(() => {
            if (pending !== p) return;
            settle(p);
            p.reject(new AuthError('sign_in_cancelled'));
          }, grace);
        });
      })();
      listening.catch(() => {
        listening = null;
      });
    }
    return listening;
  }

  return {
    start: (url, callbackScheme) => {
      if (pending) return Promise.reject(new AuthError('sign_in_in_progress'));
      if (!isWebUrl(url)) return Promise.reject(new AuthError('sign_in_failed'));
      return new Promise<string>((resolve, reject) => {
        const p: PendingStart = { scheme: callbackScheme, resolve, reject, graceTimer: undefined };
        pending = p;
        const fail = (code: AuthErrorCode): void => {
          if (pending !== p) return;
          settle(p);
          reject(new AuthError(code));
        };
        ensureListeners()
          .then(() => deps.browser.open({ url }))
          .catch(() => {
            fail('sign_in_failed');
          });
      });
    },
  };
}

/** Thin real-plugin wiring for Android; the behaviour above is what the tests cover. */
export function createCapacitorAuthSession(): AuthSession {
  return createAndroidAuthSession({ browser: Browser, app: App });
}
