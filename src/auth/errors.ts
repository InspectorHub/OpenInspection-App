/**
 * Every failure the sign-in layer can show. The message is fixed English text
 * chosen here; nothing a server sends (an `error_description`, a body, a URL)
 * is ever copied into an error.
 */
export const AUTH_ERROR_CODES = [
  'invalid_server_url',
  'server_unreachable',
  'server_timeout',
  'server_redirected',
  'server_response_invalid',
  'native_login_unavailable',
  'registration_failed',
  'crypto_unavailable',
  'callback_invalid',
  'sign_in_denied',
  'sign_in_cancelled',
  'sign_in_expired',
  'sign_in_in_progress',
  'sign_in_failed',
  'scope_mismatch',
  'session_role_not_allowed',
  'identity_mismatch',
  'storage_failed',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export const AUTH_ERROR_MESSAGE_KEYS: Record<AuthErrorCode, string> = {
  invalid_server_url: 'auth.error.invalidServerUrl',
  server_unreachable: 'auth.error.serverUnreachable',
  server_timeout: 'auth.error.serverTimeout',
  server_redirected: 'auth.error.serverRedirected',
  server_response_invalid: 'auth.error.serverResponseInvalid',
  native_login_unavailable: 'auth.error.nativeLoginUnavailable',
  registration_failed: 'auth.error.registrationFailed',
  crypto_unavailable: 'auth.error.cryptoUnavailable',
  callback_invalid: 'auth.error.callbackInvalid',
  sign_in_denied: 'auth.error.signInDenied',
  sign_in_cancelled: 'auth.error.signInCancelled',
  sign_in_expired: 'auth.error.signInExpired',
  sign_in_in_progress: 'auth.error.signInInProgress',
  sign_in_failed: 'auth.error.signInFailed',
  scope_mismatch: 'auth.error.scopeMismatch',
  session_role_not_allowed: 'auth.error.sessionRoleNotAllowed',
  identity_mismatch: 'auth.error.identityMismatch',
  storage_failed: 'auth.error.storageFailed',
};

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  invalid_server_url: 'Enter the server address as an https address, for example https://app.example.com.',
  server_unreachable: 'The server could not be reached.',
  server_timeout: 'The server took too long to answer.',
  server_redirected: 'The server tried to send the app to another address, so the request was stopped.',
  server_response_invalid: 'The server answered in a way this app does not understand.',
  native_login_unavailable: 'This server does not allow sign-in from the app.',
  registration_failed: 'The app could not be registered with this server.',
  crypto_unavailable: 'This device cannot create a secure sign-in request.',
  callback_invalid: 'The sign-in response could not be verified.',
  sign_in_denied: 'Sign-in was not approved.',
  sign_in_cancelled: 'Sign-in was cancelled.',
  sign_in_expired: 'The sign-in took too long. Please try again.',
  sign_in_in_progress: 'A sign-in is already in progress.',
  sign_in_failed: 'Sign-in failed. Please try again.',
  scope_mismatch: 'The server granted different access than the app asked for.',
  session_role_not_allowed: 'This account type cannot use the app.',
  identity_mismatch: 'This device holds data for a different account.',
  storage_failed: 'The sign-in could not be saved on this device.',
};

/**
 * What a failed attempt to get a token says about the server, carried as a structured fact so nobody has to guess it from the
 * error code: `no_answer` (no connection, or none in time), `answered` (the server replied but not with a usable token),
 * `local` (this device's own storage failed), `upgrade_required` (the server refuses this app version) and `none` (nothing).
 */
export type RetryCause = 'no_answer' | 'answered' | 'local' | 'upgrade_required' | 'none';

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly messageKey: string;
  /** Set only on an error that a failed token fetch throws; absent on every other `AuthError`. */
  readonly retryCause: RetryCause | undefined;

  constructor(code: AuthErrorCode, retryCause?: RetryCause) {
    super(AUTH_ERROR_MESSAGES[code]);
    this.name = 'AuthError';
    this.code = code;
    this.messageKey = AUTH_ERROR_MESSAGE_KEYS[code];
    this.retryCause = retryCause;
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
