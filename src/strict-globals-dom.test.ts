// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installStrictGlobals, restoreGlobals } from './test-support/strict-globals';

beforeEach(installStrictGlobals);
afterEach(restoreGlobals);

describe('the strict global shim where a window exists', () => {
  it('rejects a builtin read from window and called with another this', () => {
    const detached = { setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, fetch: window.fetch };
    expect(() => detached.setTimeout(() => undefined, 1)).toThrow('Illegal invocation');
    expect(() => detached.clearTimeout(undefined)).toThrow('Illegal invocation');
    expect(() => void detached.fetch('http://x.test/')).toThrow('Illegal invocation');
  });

  it('allows a bare call and a call through window or globalThis', () => {
    clearTimeout(setTimeout(() => undefined, 1));
    window.clearTimeout(window.setTimeout(() => undefined, 1));
    globalThis.clearTimeout(globalThis.setTimeout(() => undefined, 1));
  });

  it('puts the originals back afterwards', () => {
    const strict = window.setTimeout;
    restoreGlobals();
    expect(window.setTimeout).not.toBe(strict);
    expect(() => {
      const detached = { setTimeout: window.setTimeout };
      clearTimeout(detached.setTimeout(() => undefined, 1) as unknown as number);
    }).not.toThrow();
    installStrictGlobals();
  });
});
