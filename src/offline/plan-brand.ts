/**
 * The issuer brand of a reconcile plan.
 *
 * A plan is plain data, and what it says (which inspections to purge, with what fingerprints) is acted on by deleting
 * a person's work. So the executor and the person-confirmed removal accept ONLY a plan object that `decideReconcile`
 * itself returned: it is registered here at that moment, in a WeakSet that nothing outside this module can write to
 * except through `issuePlan` / `markIssued`. A spread copy, a clone, a parsed copy or a hand-built object with the right
 * fingerprints is not in the set and is refused. Plans that come out of `decideReconcile` are also frozen, so an issued
 * plan cannot be edited into saying something else.
 *
 * `issuePlan` and `markIssued` are for `reconcile-decision.ts` and the test support only; a test
 * (`brands.test.ts`) fails when any other source file imports them.
 */

const issued = new WeakSet<object>();

/**
 * Freezes `value` and everything reachable from it. An object that is ALREADY frozen is still descended into: freezing is
 * shallow, so a frozen outer object can hold a mutable inner one, and stopping there would leave that inner object editable
 * inside an issued plan. `seen` ends the walk on a cycle.
 */
function deepFreeze(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner, seen);
}

/** Registers a plan as issued without freezing it. For the test support, which builds fixtures it then edits. */
export function markIssued<T extends object>(plan: T): T {
  issued.add(plan);
  return plan;
}

/** Registers a plan as issued and freezes it. Called by `decideReconcile` for each plan it returns. */
export function issuePlan<T extends object>(plan: T): T {
  deepFreeze(plan);
  issued.add(plan);
  return plan;
}

/** True only for a plan object `decideReconcile` returned (or a test fixture registered through the test support). */
export function isIssuedPlan(plan: unknown): boolean {
  return typeof plan === 'object' && plan !== null && issued.has(plan);
}
