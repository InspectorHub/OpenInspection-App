import type { AppLike } from '../auth/auth-session';
import type { LoginFlow } from '../auth/pkce-login';

/** The one thing the router needs from the login flow. */
export type CallbackTarget = Pick<LoginFlow, 'handleCallback'>;

export interface CallbackRouter {
  /** Starts routing to `flow`. Returns a function that stops. */
  bind(flow: CallbackTarget): () => void;
}

/** The part of Vite's hot-module API the router uses. */
export interface HotLike {
  dispose(callback: () => void): void;
}

export interface CallbackRouterOptions {
  /** Defaults to `import.meta.hot`, which is undefined in a production build. */
  hot?: HotLike;
}

/**
 * Registers the `appUrlOpen` listener at app start, and hands every URL to the bound login flow.
 *
 * The flow ignores a URL that is not the exact callback, one with no login waiting, and one whose state
 * is not the waiting login's, so a callback that arrives when nothing asked for it (the app was killed
 * while the sign-in tab stayed open, and the one-time PKCE verifier died with it) ends here without a
 * network call. The URL is never logged: it carries an authorization code.
 *
 * If the plugin refuses the registration, the next `bind()` tries again. When the module is replaced
 * during development, the old listener is removed so two routers never answer the same URL.
 */
export function registerCallbackRouter(app: AppLike, options: CallbackRouterOptions = {}): CallbackRouter {
  let target: CallbackTarget | null = null;
  let registration: ReturnType<AppLike['addListener']> | null = null;
  let disposed = false;

  function register(): void {
    if (registration || disposed) return;
    let pending: ReturnType<AppLike['addListener']>;
    try {
      pending = app.addListener('appUrlOpen', (event) => {
        const flow = target;
        const url: unknown = typeof event === 'object' && event !== null ? event.url : undefined;
        if (disposed || !flow || typeof url !== 'string') return;
        try {
          flow.handleCallback(url).catch(() => undefined);
        } catch {
          // Nothing to report: the login that was waiting reports its own failure to its own screen.
        }
      });
    } catch {
      return;
    }
    registration = pending;
    pending.catch(() => {
      if (registration === pending) registration = null;
    });
  }

  (options.hot ?? import.meta.hot)?.dispose(() => {
    disposed = true;
    target = null;
    const previous = registration;
    registration = null;
    previous?.then((handle) => handle.remove()).catch(() => undefined);
  });

  register();
  return {
    bind: (flow) => {
      target = flow;
      register();
      return () => {
        if (target === flow) target = null;
      };
    },
  };
}
