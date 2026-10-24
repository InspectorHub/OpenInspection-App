import type { AppServices } from '../app/compose';
import type { LockReason } from './lock';
import { evaluateAndPersist } from './lock-state';

export type VerifyResult =
  | { kind: 'unlocked' }
  /** The server answered but the device is still locked (a clock the server does not confirm, or a revocation). */
  | { kind: 'locked'; reason: LockReason }
  /** The sign-in was refused. Local data stays; the person signs in again. */
  | { kind: 'sign_in_required' }
  | { kind: 'retry'; cause: 'offline' | 'server' };

/**
 * The lock screen's "Verify online": asks the server whether it still accepts this device, ignoring
 * any backoff because a person asked. The auth layer records the verification itself (see
 * `tokens.onVerified`); this only re-evaluates afterwards, so the answer comes from the same rules
 * as every other trigger. A session-confirmed verification whose server time (the `serverNowMs` body
 * field, or the `Date` header when the server exposes it) agrees with the device clock re-anchors the
 * clock reference (see `recordVerified`), so correcting a wrong date and then verifying online unlocks
 * the device without clearing local data; with no server time available, or one that disagrees, a
 * clock lock stays.
 *
 * A refused refresh is `sign_in_required`, never revoked: the server answers it the same way for a
 * removed member, a role change and a password change.
 */
export async function verifyOnline(services: AppServices, origin: string): Promise<VerifyResult> {
  const check = await services.tokens.checkSession(origin, { ignoreBackoff: true });
  if (check.kind === 'retry') return { kind: 'retry', cause: check.reason === 'network' || check.reason === 'timeout' ? 'offline' : 'server' };
  if (check.kind === 'signed_out') return { kind: 'sign_in_required' };
  const outcome = await evaluateAndPersist(services.db, services.clock.now());
  if (check.kind === 'relogin') return outcome.locked && outcome.reason === 'revoked' ? { kind: 'locked', reason: 'revoked' } : { kind: 'sign_in_required' };
  return outcome.locked ? { kind: 'locked', reason: outcome.reason } : { kind: 'unlocked' };
}
