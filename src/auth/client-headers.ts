const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * The `X-Client-*` style headers a caller may add to a request, with every credential header removed whatever
 * its case or surrounding blanks. Authority comes from the token manager (or a signed url), never from here.
 * `alsoForbidden` names headers the caller sets itself and must not see doubled under another spelling.
 */
export function safeClientHeaders(headers: Record<string, string>, alsoForbidden: readonly string[] = []): Record<string, string> {
  const forbidden = new Set([...CREDENTIAL_HEADERS, ...alsoForbidden.map((name) => name.toLowerCase())]);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!forbidden.has(name.trim().toLowerCase())) kept[name] = value;
  }
  return kept;
}
