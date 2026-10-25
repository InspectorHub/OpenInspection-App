/**
 * The one parser for an address that came from outside the app (a server field, a link in the editor) and is about to be
 * handed to the system browser. Only https passes; the normalised form is returned, so what was checked is what is opened.
 * Anything else, including a value that is not text, is null.
 */
export function httpsHref(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
