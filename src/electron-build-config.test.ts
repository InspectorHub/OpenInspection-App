import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDefines } from '../vite.defines.ts';

describe('renderer compile-time defines', () => {
  it('preserves the Android build constants and honors a reproducible build instant', () => {
    const previous = process.env.APP_BUILT_AT;
    process.env.APP_BUILT_AT = '2026-10-29T12:00:00.000Z';
    try {
      // Read the expected version from the same package.json the builder reads,
      // so a version bump does not require editing this assertion.
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
      expect(buildDefines()).toEqual({ __APP_VERSION__: JSON.stringify(pkg.version), __APP_BUILT_AT__: JSON.stringify('2026-10-29T12:00:00.000Z') });
    } finally {
      if (previous === undefined) delete process.env.APP_BUILT_AT;
      else process.env.APP_BUILT_AT = previous;
    }
  });
});
