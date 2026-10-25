import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package refuses every publish unless the host says what the human-verification step is. Whether the native shell
 * may declare that step unnecessary is a product decision that has not been made, so no code of the app may set the slot:
 * the package's default (fail closed) must stay in force. A test file may name the slot to prove this; the app's own sources may not.
 */
export function setsHumanCheck(source: string): boolean {
  return /\bhumanCheck\b/.test(source);
}

const src = fileURLToPath(new URL('..', import.meta.url));
const sources = readdirSync(src, { recursive: true, encoding: 'utf-8' })
  .map((name) => name.replaceAll('\\', '/'))
  .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.includes('test-support/'));

describe('the human-verification slot', () => {
  it('the scan sees what it is meant to see', () => {
    expect(setsHumanCheck("<FieldDataSourceProvider slots={{ humanCheck: 'not-required' }}")).toBe(true);
    expect(setsHumanCheck('const slots = { ...base, humanCheck }')).toBe(true);
    expect(setsHumanCheck('const humanChecks = []; // a human check')).toBe(false);
  });

  it('finds the sources it is about to scan, the editor data source among them', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain('field/local-data-source.ts');
  });

  it('no source of the app sets it', () => {
    const offenders = sources.filter((name) => setsHumanCheck(readFileSync(join(src, name), 'utf-8')));
    expect(offenders).toEqual([]);
  });
});
