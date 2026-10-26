import type { AuthErrorCode, RetryCause } from './errors';
import type { RetryReason } from './tokens';

/**
 * What a retry reason says about the server. `backoff` and `superseded` say nothing of their own: a back-off carries the cause
 * of the failure that started it (the token manager stores it), so it maps to `none` here and is never read from this function.
 */
export function causeOfReason(reason: RetryReason): RetryCause {
  switch (reason) {
    case 'network':
    case 'timeout':
      return 'no_answer';
    case 'server':
    case 'unavailable':
    case 'rate_limited':
    case 'malformed':
      return 'answered';
    case 'upgrade_required':
      return 'upgrade_required';
    case 'storage':
      return 'local';
    case 'backoff':
    case 'superseded':
      return 'none';
  }
}

/** The error a caller of `getAccessToken` gets. Only a failure with no answer is ever called "unreachable". */
export function codeForRetry(reason: RetryReason, cause: RetryCause): AuthErrorCode {
  if (reason === 'timeout') return 'server_timeout';
  if (reason === 'network') return 'server_unreachable';
  if (reason === 'storage') return 'storage_failed';
  if (reason === 'superseded') return 'sign_in_in_progress';
  if (reason === 'backoff') {
    if (cause === 'no_answer') return 'server_unreachable';
    if (cause === 'local') return 'storage_failed';
  }
  return 'server_response_invalid';
}
