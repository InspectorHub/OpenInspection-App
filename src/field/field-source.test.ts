import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The editor's data source must reach the server only through the authenticated wrapper: no fetch of its own, no
 * ambient credentials, no blocking confirm dialog, and no escape hatches from the type system.
 */
const FORBIDDEN: [string, RegExp][] = [
  ['a direct fetch', /(?<![\w.$])fetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['ambient credentials', /credentials\s*:/],
  ['a window.confirm', /window\.confirm|(?<![\w.$])confirm\s*\(/],
  ['a type escape', /\bas any\b|<any>/],
  ['a leftover marker', /\b(?:TODO|FIXME)\b/],
  ['a skipped test', /\.skip\(|\bxit\(|\bxdescribe\(/],
];

export function violations(source: string): string[] {
  return FORBIDDEN.filter(([, pattern]) => pattern.test(source)).map(([name]) => name);
}

const dir = fileURLToPath(new URL('.', import.meta.url));
const files = readdirSync(dir, { recursive: true, encoding: 'utf-8' })
  .map((name) => name.replaceAll('\\', '/'))
  .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'));

describe('src/field sources', () => {
  it('the scan sees what it is meant to see', () => {
    expect(violations('const r = fetch(url, { credentials: "include" });')).toEqual(['a direct fetch', 'ambient credentials']);
    expect(violations('const x = y as any; // TODO')).toEqual(['a type escape', 'a leftover marker']);
    expect(violations('const ok = await api.send(call);')).toEqual([]);
  });

  it('finds the module files it is about to scan', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('commands.ts');
  });

  it.each(files.filter((name) => !name.includes('.test.') && !name.startsWith('test-support/')))('%s is clean', (name) => {
    expect(violations(readFileSync(join(dir, name), 'utf-8'))).toEqual([]);
  });

  it('every module is under 400 lines', () => {
    for (const name of files) {
      const lines = readFileSync(join(dir, name), 'utf-8').split('\n').length;
      expect(lines, `${name} has ${String(lines)} lines`).toBeLessThan(400);
    }
  });
});
