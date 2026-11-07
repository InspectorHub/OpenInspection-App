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
  it('pads the root by the keyboard height, so a page the keyboard covers can scroll', () => {
    expect(read('src/styles.css')).toMatch(/#root\s*\{[^}]*padding-bottom:\s*var\(--keyboard-height,\s*0px\)/);
    expect(read('src/main.tsx')).toMatch(/Capacitor\.getPlatform\(\) === 'ios'\) \{[^}]*followKeyboardInset/);
  });

  it('asks the shared UI to pin the page behind a dialog on iOS only, where a scrolled page would push a fixed sheet down', () => {
    expect(read('src/main.tsx')).toMatch(/Capacitor\.getPlatform\(\) === 'ios'\) \{\s*document\.documentElement\.dataset\.scrollLock = 'pin'/);
  });

  it('raises text fields to 16px on iOS so focusing one does not zoom the page', () => {
    const css = read('src/styles.css');
    const block = /@supports \(-webkit-touch-callout: none\)\s*\{([^}]*\{[^}]*\})\s*\}/.exec(css);
    expect(block).not.toBeNull();
    expect(block?.[1]).toMatch(/textarea/);
    expect(block?.[1]).toMatch(/font-size:\s*max\(16px,/);
  });
});
