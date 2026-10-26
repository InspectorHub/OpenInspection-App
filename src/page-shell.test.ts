import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string): string => readFileSync(join(process.cwd(), name), 'utf8');

describe('page shell', () => {
  it('declares both colour schemes so native controls and scrollbars follow the theme', () => {
    expect(read('index.html')).toMatch(/<meta\s+name="color-scheme"\s+content="light dark"\s*\/?>/);
  });

  it('keeps a visible focus indicator in forced-colors mode, using a system colour keyword', () => {
    const css = read('src/styles.css');
    const block = /@media \(forced-colors: active\)\s*\{[^}]*:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block?.[1]).toMatch(/outline:\s*\d+px solid Highlight/);
  });
});
