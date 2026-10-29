import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The package refuses every publish unless the host says what the human-verification step is. The native shell has none by design
 * (the person is signed in on the device), and says so in ONE place, the editor screen. No other source of the app may touch the
 * slot, so the fail-closed default stays in force everywhere else. A test file may name the slot; the app's own sources may not.
 */
const THE_EDITOR_SCREEN = 'ui/EditorScreen.tsx';
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
  // The generated contract types are the server's description, which uses the word for printed form slots; it is not app code.
  .filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !name.includes('test-support/') && name !== 'api/schema.d.ts');

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

  it('no source of the app sets it but the editor screen', () => {
    const offenders = sources.filter((name) => humanCheckUses(readFileSync(join(src, name), 'utf-8')).length > 0);
    expect(offenders).toEqual([THE_EDITOR_SCREEN]);
  });

  it('the editor screen opts out with the one exact value and installs no check of its own', () => {
    const source = readFileSync(join(src, THE_EDITOR_SCREEN), 'utf-8');
    expect(source).toContain("humanCheck: 'not-required'");
    expect(source).not.toMatch(/ensure\W*human/i);
    expect(source.match(/not-required/g)).toHaveLength(1);
  });
});
