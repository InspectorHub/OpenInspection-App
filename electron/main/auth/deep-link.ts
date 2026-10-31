import { CALLBACK_SCHEME, parseCallbackUrl } from '../../../src/auth/callback-constants.ts';

const MAX_CALLBACK_URL_LENGTH = 4096;

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

export function extractCallbackUrl(argv: readonly string[]): string | null {
  for (const argument of argv) {
    const candidate = unquote(argument);
    if (candidate.length > MAX_CALLBACK_URL_LENGTH) continue;
    if (parseCallbackUrl(candidate, CALLBACK_SCHEME)) return candidate;
  }
  return null;
}

export function createDeepLinkHub(): {
  push(url: string): void;
  subscribe(listener: (url: string) => void): () => void;
} {
  const listeners = new Set<(url: string) => void>();
  let buffered: string | null = null;

  function deliver(listener: (url: string) => void, url: string): void {
    try { listener(url); } catch { /* A renderer callback must not interrupt protocol dispatch. */ }
  }

  return {
    push(url) {
      if (url.length > MAX_CALLBACK_URL_LENGTH || !parseCallbackUrl(url, CALLBACK_SCHEME)) return;
      if (listeners.size === 0) {
        buffered = url;
        return;
      }
      for (const listener of [...listeners]) deliver(listener, url);
    },
    subscribe(listener) {
      listeners.add(listener);
      if (buffered !== null) {
        const url = buffered;
        buffered = null;
        deliver(listener, url);
      }
      return () => { listeners.delete(listener); };
    },
  };
}
