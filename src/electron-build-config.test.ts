import { describe, expect, it } from 'vitest';
import { buildDefines } from '../vite.defines.ts';

describe('renderer compile-time defines', () => {
  it('preserves the Android build constants and honors a reproducible build instant', () => {
    const previous = process.env.APP_BUILT_AT;
    process.env.APP_BUILT_AT = '2026-10-29T12:00:00.000Z';
    try {
      expect(buildDefines()).toEqual({ __APP_VERSION__: JSON.stringify('0.1.1'), __APP_BUILT_AT__: JSON.stringify('2026-10-29T12:00:00.000Z') });
    } finally {
      if (previous === undefined) delete process.env.APP_BUILT_AT;
      else process.env.APP_BUILT_AT = previous;
    }
  });
});
