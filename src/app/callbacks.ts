import type { AppLike } from '../auth/auth-session';
import type { LoginFlow } from '../auth/pkce-login';

/** The one thing the router needs from the login flow. */
export type CallbackTarget = Pick<LoginFlow, 'handleCallback'>;

export interface CallbackRouter {
  /** Starts routing to `flow`. Returns a function that stops. */
  bind(flow: CallbackTarget): () => void;
}

/**
 * Registers the `appUrlOpen` listener once, at app start, and hands every URL to the bound login flow.
 *
 * The flow ignores a URL that is not the exact callback, one with no login waiting, and one whose state
 * is not the waiting login's, so a callback that arrives when nothing asked for it (the app was killed
 * while the sign-in tab stayed open, and the one-time PKCE verifier died with it) ends here without a
 * network call. The URL is never logged: it carries an authorization code.
 */
export function registerCallbackRouter(app: AppLike): CallbackRouter {
  let target: CallbackTarget | null = null;
  app
    .addListener('appUrlOpen', (event) => {
      const flow = target;
      if (!flow || typeof event.url !== 'string') return;
      try {
        flow.handleCallback(event.url).catch(() => undefined);
      } catch {
        // Nothing to report: the login that was waiting reports its own failure to its own screen.
      }
    })
    .catch(() => undefined);
  return {
    bind: (flow) => {
      target = flow;
      return () => {
        if (target === flow) target = null;
      };
    },
  };
}
