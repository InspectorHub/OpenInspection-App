import { vi } from 'vitest';

/**
 * Browser builtins such as `setTimeout` and `fetch` throw `TypeError: Illegal invocation` in a real
 * WebView when they are called with any `this` other than the window. Node does not care, so a bug of
 * that kind passes every ordinary test. This installs stand-ins that enforce the browser rule: each
 * one throws unless it was called bare (`this` undefined) or as a method of `globalThis`.
 * Call `restoreGlobals()` in `afterEach`.
 */
function guard<A extends unknown[], R>(name: string, real: (...args: A) => R): (this: unknown, ...args: A) => R {
  return function strictBuiltin(this: unknown, ...args: A): R {
    if (this !== undefined && this !== globalThis) throw new TypeError(`Failed to execute '${name}': Illegal invocation`);
    return real(...args);
  };
}

export function installStrictGlobals(): void {
  const realSetTimeout = globalThis.setTimeout.bind(globalThis);
  const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const realSetInterval = globalThis.setInterval.bind(globalThis);
  const realClearInterval = globalThis.clearInterval.bind(globalThis);
  const realQueueMicrotask = globalThis.queueMicrotask.bind(globalThis);
  const realFetch = globalThis.fetch.bind(globalThis);
  const realCrypto = globalThis.crypto;
  vi.stubGlobal('setTimeout', guard('setTimeout', realSetTimeout));
  vi.stubGlobal('clearTimeout', guard('clearTimeout', realClearTimeout));
  vi.stubGlobal('setInterval', guard('setInterval', realSetInterval));
  vi.stubGlobal('clearInterval', guard('clearInterval', realClearInterval));
  vi.stubGlobal('queueMicrotask', guard('queueMicrotask', realQueueMicrotask));
  vi.stubGlobal('fetch', guard('fetch', realFetch));
  const strictCrypto = {
    getRandomValues<T extends ArrayBufferView>(this: unknown, array: T): T {
      if (this !== strictCrypto) throw new TypeError("Failed to execute 'getRandomValues' on 'Crypto': Illegal invocation");
      return realCrypto.getRandomValues(array as never) as T;
    },
    randomUUID(this: unknown): string {
      if (this !== strictCrypto) throw new TypeError("Failed to execute 'randomUUID' on 'Crypto': Illegal invocation");
      return realCrypto.randomUUID();
    },
    subtle: realCrypto.subtle,
  };
  vi.stubGlobal('crypto', strictCrypto);
}

export function restoreGlobals(): void {
  vi.unstubAllGlobals();
}
