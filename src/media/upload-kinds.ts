/** The fixed vocabulary of upload failures. Nothing from a server, the plugin or a path is ever added to it. */
export type UploadFailureCode =
  | 'LOCKED'
  | 'AUTH'
  | 'REJECTED'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'FILE'
  | 'BAD_URL'
  | 'INVALID'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_KIND'
  | 'UPGRADE'
  | 'PLUGIN'
  | 'STORE'
  /** The file is larger than the engine accepts; sending it cannot help. */
  | 'TOO_LARGE'
  /** Every attempt is used and nothing more is remembered about why; `retry()` is the way out. */
  | 'GIVEN_UP'
  /** The inspection is quarantined or being purged: nothing was sent, nothing was recorded, the row is as it was. */
  | 'BLOCKED'
  /** The uploader was disposed (the session ended): nothing was sent, the row is as it was, and the next session picks it up. */
  | 'DISPOSED';

export interface Failure {
  code: UploadFailureCode;
  retryable: boolean;
  retryAfterMs: number | null;
  halt: boolean;
}

export function failure(code: UploadFailureCode, options: { retryable: boolean; retryAfterMs?: number | null; halt?: boolean }): Failure {
  return { code, retryable: options.retryable, retryAfterMs: options.retryAfterMs ?? null, halt: options.halt ?? false };
}

/** The longest a server's Retry-After may hold a retry. */
export const MAX_RETRY_AFTER_MS = 300_000;

export function clampRetryAfter(ms: number | null): number | null {
  return ms === null ? null : Math.max(0, Math.min(ms, MAX_RETRY_AFTER_MS));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_URL_LENGTH = 4096;
const UPLOAD_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,512}$/;
/** Whitespace, control characters, DEL and backslash: a url containing one is refused before it is parsed. */
export const UNSAFE_URL_CHARACTERS = /[\u0000- \u007f\\]/;

/** True when `raw` is a string that may be parsed as a url at all: not empty, not oversized, free of the unsafe characters. */
export function isParseableUrlText(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length > 0 && raw.length <= MAX_URL_LENGTH && !UNSAFE_URL_CHARACTERS.test(raw);
}

/**
 * The signed upload url, resolved against the pinned origin and accepted only in the one shape the engine
 * mints: same origin, no userinfo, the given path, a single well-formed `token` parameter, no fragment.
 * A url naming any other host, scheme, port or path is refused, so a file is never sent to a place the
 * server answer merely pointed at.
 */
export function resolveUploadUrl(origin: string, raw: unknown, path: string): string | null {
  if (!isParseableUrlText(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (url.pathname !== path) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'token') return null;
  if (!UPLOAD_TOKEN_PATTERN.test(url.searchParams.get('token') ?? '')) return null;
  return url.href;
}

/**
 * The signed upload url of a route whose url the engine builds from its OWN public origin, which may differ from the
 * server address the user typed (a development tunnel, an alias). Only two things in the answer matter: the path and
 * the single `token` parameter. The supplied scheme, host and port are ignored entirely, and the url that is returned
 * is built here as `<pinned origin><path>?token=<token>`, so the file never goes anywhere but the pinned origin and
 * nothing of the server's string (not `href`, not the search part) is reused. The token is an HMAC over the
 * tenant, inspection, media, user, kind and expiry with no host bound into it, so presenting it to the pinned origin
 * is correct. Refused: userinfo, a fragment, a scheme other than http(s), a percent escape or a dot segment in the
 * path, a path that is not exactly `path`, and any query other than one well-formed `token`.
 */
export function resolveRelocatableUploadUrl(origin: string, raw: unknown, path: string): string | null {
  if (!isParseableUrlText(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.hash !== '') return null;
  if (url.pathname !== path) return null;
  // The parser normalises escapes and dot segments; the text must already have been the plain path.
  const rawPath = raw.split(/[?#]/, 1)[0] ?? '';
  if (!rawPath.endsWith(path) || rawPath.includes('%') || /\/\.\.?(\/|$)/.test(rawPath)) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'token') return null;
  const token = url.searchParams.get('token') ?? '';
  if (!UPLOAD_TOKEN_PATTERN.test(token)) return null;
  return `${origin}${path}?token=${token}`;
}
