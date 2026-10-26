import { isAuthError, type RetryCause } from '../auth/errors';
import type { Http } from '../auth/http';
import type { TokenManager } from '../auth/tokens';

export interface ReachSink {
  /** The server answered something (any status): it can be reached. */
  reached(): void;
  /** A request to the server got no answer (no connection, or no reply in time). */
  unreachable(): void;
  /** The server answered but sync cannot go on (an unusable answer to the token request), or this device's own storage failed. */
  paused(): void;
}

type Tokens = Pick<TokenManager, 'getAccessToken' | 'checkSession'>;

/** Tells the sink what a cause means. An upgrade is the update panel's to show, and `none` is nothing: neither changes the status. */
function tell(sink: ReachSink, cause: RetryCause): void {
  try {
    if (cause === 'no_answer') sink.unreachable();
    else if (cause === 'answered' || cause === 'local') sink.paused();
  } catch {
    // The sink only reports; whatever it does, the call it watched keeps its own outcome.
  }
}

function reached(sink: ReachSink): void {
  try {
    sink.reached();
  } catch {
    // See `tell`.
  }
}

/**
 * Wraps the stack's `http` and `tokens` so every server contact reports what it shows about the server. It changes nothing
 * about what the wrapped calls return or throw; it only watches, and a sink that throws is ignored. A cached token proves
 * nothing about the server, so only a failed token fetch (which carries its cause), a session verdict and a real answer report.
 * An `http` error is "no answer" only for a failed connection or a timeout; a redirect or an unreadable reply is an answer.
 */
export function observeServerContact(http: Http, tokens: Tokens, sink: ReachSink): { http: Http; tokens: Tokens } {
  return {
    http: {
      request: async (req) => {
        let res;
        try {
          res = await http.request(req);
        } catch (err) {
          if (isAuthError(err) && (err.code === 'server_unreachable' || err.code === 'server_timeout')) tell(sink, 'no_answer');
          throw err;
        }
        reached(sink);
        return res;
      },
    },
    tokens: {
      getAccessToken: async (origin) => {
        try {
          return await tokens.getAccessToken(origin);
        } catch (err) {
          if (isAuthError(err) && err.retryCause !== undefined) tell(sink, err.retryCause);
          throw err;
        }
      },
      checkSession: async (origin, options) => {
        const check = await tokens.checkSession(origin, options);
        if (check.kind === 'retry') tell(sink, check.cause);
        else if (check.kind === 'ok' || check.kind === 'relogin') reached(sink);
        return check;
      },
    },
  };
}
