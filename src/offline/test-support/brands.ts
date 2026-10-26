import { markIssued } from '../plan-brand';
import { purgeAuthority } from '../purge-authority';
import type { ReconcilePlan } from '../reconcile-decision';

/**
 * Registers a plan fixture as one `decideReconcile` issued, so a test of the executor or of the person-confirmed removal
 * can edit the plan (a narrower reason, another fingerprint) and still reach the check under test. Never freezes.
 */
export function issuePlanForTest(plan: ReconcilePlan): ReconcilePlan {
  return markIssued(plan);
}

/** The authority a test of `purgeInspection` passes for its `user_confirmed` and `resume` modes. */
export const purgeAuthorityForTest = purgeAuthority;
