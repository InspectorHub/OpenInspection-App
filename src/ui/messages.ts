import { AUTH_ERROR_MESSAGES, isAuthError, type AuthErrorCode } from '../auth/errors';
import type { CompatNotice } from '../app/compat-notice';

/**
 * The only way an error reaches the screen: a fixed message chosen by the app for the error's
 * code. Whatever else an error carries (a server's text, a URL, a stack) is never shown.
 */
export function messageFor(err: unknown, fallback: AuthErrorCode = 'sign_in_failed'): string {
  return AUTH_ERROR_MESSAGES[isAuthError(err) ? err.code : fallback];
}

export const NOTICE_MESSAGES: Record<CompatNotice, string> = {
  server_too_old: 'This server is older than the app expects. You can sign in and work offline, but syncing may not work until the server is updated.',
  update_required: 'This version of the app is no longer supported by this server. Update the app soon.',
  update_available: 'A newer version of the app is available.',
};

export const NATIVE_LOGIN_HELP =
  'The server answered, but it has not switched on sign-in from the app. If you run this server, an administrator needs to enable native client sign-in. Otherwise, ask whoever runs it.';
