/**
 * The settings sheet forwards its whole form. Empty strings mean "unchanged", a date input emits a bare date where the
 * API wants a date-time, and a price is a number. Same rules as the engine's `sanitizeSettingsPatch`
 * (`app/lib/settings-patch.ts`), so a partial save validates the same way.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function sanitizeSettingsPatch(form: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(form)) {
    // An own `__proto__` (JSON.parse makes one) would become the prototype of `out` and lend it values its keys never listed.
    if (key === '__proto__') continue;
    if (value === '') continue;
    if (key === 'date' && typeof value === 'string' && DATE_ONLY.test(value)) {
      const at = new Date(`${value}T09:00:00`);
      // An impossible date is passed on as it is, for the registry or the server to refuse by name.
      out[key] = Number.isNaN(at.getTime()) ? value : at.toISOString();
      continue;
    }
    if (key === 'price') {
      const n = Number(value);
      if (Number.isNaN(n)) continue;
      out[key] = n;
      continue;
    }
    out[key] = value;
  }
  return out;
}
