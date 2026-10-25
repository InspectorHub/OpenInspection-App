import { isAuthError } from '../auth/errors';
import type { Http } from '../auth/http';
import type { TokenManager } from '../auth/tokens';

export interface ReachSink {
  /** The server answered something (any status): it can be reached. */
  reached(): void;
  /** A request to the server got no answer (no connection, or no reply in time). */
  unreachable(): void;
}

type Tokens = Pick<TokenManager, 'getAccessToken' | 'checkSession'>;

/** The two failures that mean "no answer"; a redirect or an unreadable reply is an answer, so it is not one of them. */
function noAnswer(err: unknown): boolean {
  return isAuthError(err) && (err.code === 'server_unreachable' || err.code === 'server_timeout');
}

/**
 * Wraps the stack's `http` and `tokens` so every server contact reports whether the server answered. It changes nothing
 * about what the wrapped calls return or throw; it only watches. A cached token proves nothing about the server, so only a
 * refused or failed token fetch and a real answer are reported.
 */
export function observeServerContact(http: Http, tokens: Tokens, sink: ReachSink): { http: Http; tokens: Tokens } {
  return {
    http: {
      request: async (req) => {
        try {
          const res = await http.request(req);
          sink.reached();
          return res;
        } catch (err) {
          if (noAnswer(err)) sink.unreachable();
          throw err;
        }
      },
    },
    tokens: {
      getAccessToken: async (origin) => {
        try {
          return await tokens.getAccessToken(origin);
        } catch (err) {
          if (noAnswer(err)) sink.unreachable();
          throw err;
        }
      },
      checkSession: async (origin, options) => {
        const check = await tokens.checkSession(origin, options);
        if (check.kind === 'retry' && (check.reason === 'network' || check.reason === 'timeout')) sink.unreachable();
        else if (check.kind === 'ok' || check.kind === 'relogin') sink.reached();
        return check;
      },
    },
  };
}
