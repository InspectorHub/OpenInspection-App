/**
 * The authority to remove an inspection on a person's word, or to finish a purge that was already decided.
 *
 * `purgeInspection` deletes work nobody sent. Its automatic mode is guarded by the facts it re-reads in the tombstone
 * transaction; its `user_confirmed` and `resume` modes are not decisions the purge can re-derive, so they need the
 * caller to hold this one frozen object, which only the person-confirmed actions (`user-actions.ts`) and the resume
 * driver inside `purge.ts` take. A call that does not carry it is refused (`not_authorized`) and deletes nothing.
 *
 * It is a convention the compiler and a test (`brands.test.ts`: only the files on its list may import this module)
 * enforce, not a secret: it keeps the exported wipe from being reachable by accident or from a place that has no
 * confirmation behind it.
 */

declare const authorityBrand: unique symbol;
export type PurgeAuthority = { readonly [authorityBrand]: true };

const AUTHORITY = Object.freeze({}) as PurgeAuthority;

export function purgeAuthority(): PurgeAuthority {
  return AUTHORITY;
}

export function holdsPurgeAuthority(value: unknown): boolean {
  return value === AUTHORITY;
}
