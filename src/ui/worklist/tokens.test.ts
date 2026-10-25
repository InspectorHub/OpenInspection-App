import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const THEME = readFileSync(join(ROOT, 'node_modules', '@inspectorhub', 'field-ui', 'dist', 'theme.css'), 'utf8');

/** The new screen's own files, plus the two shared pieces it extends. */
function sources(): { name: string; text: string }[] {
  const dir = join(ROOT, 'src', 'ui', 'worklist');
  const own = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => join('src', 'ui', 'worklist', f));
  const files = [...own, join('src', 'ui', 'WorkList.tsx'), join('src', 'ui', 'kit.tsx'), join('src', 'ui', 'ConfirmDialog.tsx')];
  return files.map((name) => ({ name, text: readFileSync(join(ROOT, name), 'utf8') }));
}

function defined(prefix: string): Set<string> {
  return new Set([...THEME.matchAll(new RegExp(`--${prefix}-ih-([a-z0-9-]+)\\s*:`, 'g'))].map((m) => m[1] as string));
}

const COLORS = defined('color');
const RADII = defined('radius');
const SHADOWS = defined('shadow');
const FONTS = defined('font');

describe('the work list uses design tokens only', () => {
  it('finds the files and the theme (a scan of nothing would pass for the wrong reason)', () => {
    expect(sources().length).toBeGreaterThanOrEqual(8);
    expect(COLORS.size).toBeGreaterThan(20);
    expect(RADII.size).toBeGreaterThan(3);
    expect(SHADOWS.size).toBeGreaterThan(1);
    expect(FONTS.size).toBe(3);
  });

  it('has no raw colour literal and no palette class', () => {
    const offences: string[] = [];
    for (const { name, text } of sources()) {
      for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/g)) offences.push(`${name}: ${m[0]}`);
      for (const m of text.matchAll(/\b(?:bg|text|border|ring|fill|stroke|divide|outline|from|to|via)-(?:white|black|transparent-?[a-z]*|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/g)) {
        if (m[0] !== 'border-transparent') offences.push(`${name}: ${m[0]}`);
      }
      for (const m of text.matchAll(/\[#|\bstyle=\{\{[^}]*(?:color|background)/g)) offences.push(`${name}: ${m[0]}`);
    }
    expect(offences).toEqual([]);
  });

  it('every ih token a class names exists in the theme (a wrong name compiles to nothing)', () => {
    const unknown: string[] = [];
    let checked = 0;
    for (const { name, text } of sources()) {
      for (const m of text.matchAll(/(?<![\w-])((?:[a-z0-9-]+:)*)(bg|text|border(?:-[lrtbxy])?|ring|fill|stroke|divide|outline|accent|decoration|placeholder|caret|rounded(?:-[a-z]{1,2})?|shadow|font)-ih-([a-z0-9-]+)(?:\/\d+)?/g)) {
        const kind = m[2] as string;
        const token = m[3] as string;
        checked += 1;
        const pool = kind.startsWith('rounded') ? RADII : kind === 'shadow' ? SHADOWS : kind === 'font' ? FONTS : COLORS;
        if (!pool.has(token)) unknown.push(`${name}: ${m[0]}`);
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(unknown).toEqual([]);
  });
});
