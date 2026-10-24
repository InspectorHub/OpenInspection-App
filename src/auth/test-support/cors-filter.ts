import type { FetchLike } from '../http';

/** The response headers a cross-origin page may read without the server exposing them (the CORS-safelisted set). */
const CORS_SAFELISTED_RESPONSE_HEADERS = ['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma'];

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * What a cross-origin `fetch` hands to the page: the same status and body, but only the safelisted headers
 * and those the server listed in `Access-Control-Expose-Headers` (`exposed`, case-insensitive). `Date` is
 * not safelisted, so unless it is exposed `headers.get('date')` is null, exactly as in the WebView.
 */
export function corsFilteredResponse(response: Response, exposed: readonly string[]): Promise<Response> {
  const allowed = new Set([...CORS_SAFELISTED_RESPONSE_HEADERS, ...exposed.map((name) => name.toLowerCase())]);
  const visible = new Headers();
  response.headers.forEach((value, name) => {
    if (allowed.has(name.toLowerCase())) visible.set(name, value);
  });
  const status = response.status;
  const bodyFor = NULL_BODY_STATUSES.has(status) ? Promise.resolve(null) : response.text();
  return bodyFor.then((body) => new Response(body, { status, statusText: response.statusText, headers: visible }));
}

/** Wraps a fetch so every answer reaches the caller through the CORS header filter. */
export function withCorsFilter(inner: FetchLike, exposed: readonly string[] = []): FetchLike {
  return async (input, init) => corsFilteredResponse(await inner(input, init), exposed);
}
