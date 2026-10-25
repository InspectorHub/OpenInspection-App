/** The longest address handed to the system browser. */
export const MAX_HREF_LENGTH = 2048;

/**
 * The one parser for an address that came from outside the app (a server field, a link in the editor) and is about to be
 * handed to the system browser. Only https passes, without a user name or password, and no longer than `MAX_HREF_LENGTH`;
 * the normalised form is returned, so what was checked is what is opened. Anything else, including a value that is not
 * text, is null.
 */
export function httpsHref(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length > MAX_HREF_LENGTH) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
    return parsed.href.length > MAX_HREF_LENGTH ? null : parsed.href;
  } catch {
    return null;
  }
}
