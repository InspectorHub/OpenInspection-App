import { describe, expect, it } from 'vitest';
import type { RetryCause } from './errors';
import { causeOfReason, codeForRetry } from './retry-cause';
import type { RetryReason } from './tokens';

describe('what a failed refresh says about the server', () => {
  it.each<[RetryReason, RetryCause]>([
    ['network', 'no_answer'],
    ['timeout', 'no_answer'],
    ['server', 'answered'],
    ['unavailable', 'answered'],
    ['rate_limited', 'answered'],
    ['malformed', 'answered'],
    ['upgrade_required', 'upgrade_required'],
    ['storage', 'local'],
    ['superseded', 'none'],
  ])('%s is %s', (reason, cause) => {
    expect(causeOfReason(reason)).toBe(cause);
  });

  it('only a connection failure or a timeout is "no answer"', () => {
    const reasons: RetryReason[] = ['network', 'timeout', 'server', 'unavailable', 'rate_limited', 'malformed', 'upgrade_required', 'storage', 'backoff', 'superseded'];
    expect(reasons.filter((r) => causeOfReason(r) === 'no_answer')).toEqual(['network', 'timeout']);
  });
});

describe('the error a caller gets', () => {
  it.each([
    ['network', 'server_unreachable'],
    ['timeout', 'server_timeout'],
    ['storage', 'storage_failed'],
    ['malformed', 'server_response_invalid'],
    ['server', 'server_response_invalid'],
    ['unavailable', 'server_response_invalid'],
    ['rate_limited', 'server_response_invalid'],
    ['upgrade_required', 'server_response_invalid'],
    ['superseded', 'sign_in_in_progress'],
  ] as const)('%s gives %s, and never "unreachable" for a server that answered', (reason, code) => {
    expect(codeForRetry(reason, causeOfReason(reason))).toBe(code);
  });

  it.each([
    ['no_answer', 'server_unreachable'],
    ['local', 'storage_failed'],
    ['answered', 'server_response_invalid'],
    ['upgrade_required', 'server_response_invalid'],
  ] as const)('a back-off that began with a %s gives %s', (cause, code) => {
    expect(codeForRetry('backoff', cause)).toBe(code);
  });
});
