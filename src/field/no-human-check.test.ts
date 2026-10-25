import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package refuses every publish unless the host says what the human-verification step is. Whether the native shell
 * may declare that step unnecessary is a product decision that has not been made, so no code of the app may set the slot:
 * the package's default (fail closed) must stay in force. A test file may name the slot to prove this; the app's own sources may not.
 */
const FORBIDDEN: [string, RegExp][] = [
  ['the slot name', /human\W*(?:["'`+\s.]*)check/i],
  ['the verification hook', /ensure\W*human/i],
  ['the exemption value', /not-required/],
  ['the slots type', /\bFieldHostSlots\b/],
  ['a slots object or prop', /\bslots\b/],
  ['the slots hook', /\buseFieldSlots\b/],
];

/** What in `source` would set, hand over or read the human-verification slot. */
export function humanCheckUses(source: string): string[] {
  return FORBIDDEN.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

const src = fileURLToPath(new URL('..', import.meta.url));
const sources = readdirSync(src, { recursive: true, encoding: 'utf-8' })
  .map((name) => name.replaceAll('\\', '/'))
  .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.includes('test-support/'));

describe('the human-verification slot', () => {
  it('the scan sees what it is meant to see, in every spelling', () => {
    expect(humanCheckUses("<FieldDataSourceProvider slots={{ humanCheck: 'not-required' }}")).toEqual(['the slot name', 'the exemption value', 'a slots object or prop']);
    expect(humanCheckUses('const slots = { ...base, humanCheck }')).toContain('the slot name');
    expect(humanCheckUses("slots['human' + 'Check'] = 'x'")).toContain('the slot name');
    expect(humanCheckUses('slots["humanCheck"] = v')).toContain('the slot name');
    expect(humanCheckUses('const ok = useFieldEnsureHuman();')).toContain('the verification hook');
    expect(humanCheckUses('const s: FieldHostSlots = {}')).toContain('the slots type');
    expect(humanCheckUses("const mode = 'not-required'")).toContain('the exemption value');
    expect(humanCheckUses('const x = useFieldSlots();')).toContain('the slots hook');
  });

  it('and leaves ordinary code alone', () => {
    expect(humanCheckUses('const rows = list.filter((row) => row.checked); // a human reads it')).toEqual([]);
  });

  it('finds the sources it is about to scan, the editor data source among them', () => {
    expect(sources.length).toBeGreaterThan(100);
    expect(sources).toContain('field/local-data-source.ts');
  });

  it('no source of the app sets it', () => {
    const offenders = sources.filter((name) => humanCheckUses(readFileSync(join(src, name), 'utf-8')).length > 0);
    expect(offenders).toEqual([]);
  });
});
