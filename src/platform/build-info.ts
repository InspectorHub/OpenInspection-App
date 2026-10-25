/**
 * What the build wrote about itself. The version and the build instant are injected by `vite.config.ts` as the globals
 * `__APP_VERSION__` and `__APP_BUILT_AT__` (the same mechanism, one place); `APP_BUILT_AT` in the environment overrides the
 * instant for a reproducible build. This module only reads such a value; it never reads the clock.
 */

/** UTC only, as `Date.prototype.toISOString` writes it: a build date in any other shape is not trusted. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;

/** The build instant as epoch milliseconds, or null when it is missing or is not a real UTC ISO instant. */
export function parseBuiltAt(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  // `Date.parse` rolls an impossible day over (February 30th becomes March 2nd); a build date that needed that is damaged.
  const [, year, month, day] = match;
  const roundTrip = new Date(parsed);
  const same = roundTrip.getUTCFullYear() === Number(year) && roundTrip.getUTCMonth() + 1 === Number(month) && roundTrip.getUTCDate() === Number(day);
  return same ? parsed : null;
}
