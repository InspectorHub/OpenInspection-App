export const CALLBACK_SCHEME = 'io.inspectorhub.app';
export const CALLBACK_PATH = '/oauth/callback';
/** The one redirect URI this app registers and the engine matches exactly. */
export const REDIRECT_URI = `${CALLBACK_SCHEME}:${CALLBACK_PATH}`;

/**
 * The query of `raw` when it is exactly the callback (the private scheme, no
 * authority, the exact path), otherwise null. Everything else is not ours.
 */
export function parseCallbackUrl(raw: string, scheme: string = CALLBACK_SCHEME): URLSearchParams | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${scheme}:` || url.host !== '' || url.username || url.password || url.pathname !== CALLBACK_PATH) return null;
  return url.searchParams;
}

export function isCallbackUrl(raw: string, scheme: string): boolean {
  return parseCallbackUrl(raw, scheme) !== null;
}
