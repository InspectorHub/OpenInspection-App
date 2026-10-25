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

/** Every utility that takes a colour. A palette name after one of these is a colour the design system did not choose. */
const COLOUR_UTILITIES = '(?:bg|text|border(?:-[xytblrse])?|ring|ring-offset|inset-ring|fill|stroke|divide|outline|from|to|via|accent|decoration|caret|placeholder|shadow|inset-shadow|drop-shadow|text-shadow|scrollbar|marker|selection)';
const PALETTE = '(?:slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|mauve|olive|mist|taupe)';
const CSS_COLOUR_NAMES = '(?:red|blue|green|yellow|orange|purple|pink|black|white|gray|grey|brown|cyan|magenta|teal|navy|lime|maroon|olive|silver|gold|indigo|violet|coral|crimson|salmon|tomato|aqua|fuchsia|khaki|orchid|plum|tan|turquoise|currentcolor)';
const COLOUR_FUNCTIONS = String.raw`(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(`;
const STYLE_COLOUR_KEYS = '(?:color|backgroundColor|background|borderColor|border(?:Top|Right|Bottom|Left)Color|fill|stroke|outlineColor|caretColor|accentColor|textDecorationColor|boxShadow)';

/** Everything in a source text that sets a colour without going through a design token. */
export function colourOffences(text: string): string[] {
  const found: string[] = [];
  const add = (pattern: RegExp, keep: (hit: string) => boolean = () => true): void => {
    for (const m of text.matchAll(pattern)) if (keep(m[0])) found.push(m[0]);
  };
  // Literals: hex, and the colour functions.
  add(new RegExp(String.raw`#[0-9a-fA-F]{3,8}\b|\b${COLOUR_FUNCTIONS}`, 'g'));
  // Palette classes with a shade, white/black/transparent on a colour utility (a transparent border is the one allowed).
  add(new RegExp(String.raw`(?<![\w-])(?:[a-z0-9-]+:)*${COLOUR_UTILITIES}-(?:white|black|transparent-?[a-z]*|${PALETTE}-\d{2,3})\b`, 'g'), (hit) => !/(?:^|:)border-transparent$/.test(hit));
  // Arbitrary values that are colours: [#fff], [rgb(...)], [red], [color:...], or a variable that is not one of ours.
  add(new RegExp(String.raw`(?<![\w-])(?:[a-z0-9-]+:)*${COLOUR_UTILITIES}-\[(?:color:|#|${COLOUR_FUNCTIONS}|${CSS_COLOUR_NAMES}\]|var\(--color-(?!ih-))`, 'g'));
  // Inline styles that set a colour.
  add(new RegExp(String.raw`style=\{\{[^}]*\b${STYLE_COLOUR_KEYS}\b`, 'g'));
  return found;
}

describe('the work list uses design tokens only', () => {
  it('finds the files and the theme (a scan of nothing would pass for the wrong reason)', () => {
    expect(sources().length).toBeGreaterThanOrEqual(8);
    expect(COLORS.size).toBeGreaterThan(20);
    expect(RADII.size).toBeGreaterThan(3);
    expect(SHADOWS.size).toBeGreaterThan(1);
    expect(FONTS.size).toBe(3);
  });

  it('has no raw colour literal, no palette class, no arbitrary colour and no inline colour style', () => {
    const offences: string[] = [];
    for (const { name, text } of sources()) for (const hit of colourOffences(text)) offences.push(`${name}: ${hit}`);
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

describe('the colour detector sees what it is looking for (each pattern has a positive control)', () => {
  const FLAGGED: [string, string][] = [
    ['an accent colour from the palette', 'className="accent-red-500"'],
    ['a text decoration colour', 'className="decoration-red-500"'],
    ['a caret colour', 'className="caret-blue-600"'],
    ['a placeholder colour', 'className="placeholder-gray-400"'],
    ['a divide colour', 'className="divide-slate-200"'],
    ['a ring offset colour', 'className="ring-offset-sky-500"'],
    ['a shadow colour', 'className="shadow-black"'],
    ['a palette colour under a variant', 'className="hover:bg-red-500"'],
    ['a palette colour on a side border', 'className="border-l-green-500"'],
    ['a palette colour with an opacity', 'className="bg-red-500/50"'],
    ['white', 'className="text-white"'],
    ['an arbitrary named colour', 'className="bg-[red]"'],
    ['an arbitrary hex colour', 'className="text-[#fff]"'],
    ['an arbitrary rgb colour', 'className="bg-[rgb(1,2,3)]"'],
    ['an arbitrary hsl colour', 'className="border-[hsl(10,20%,30%)]"'],
    ['an arbitrary oklch colour', 'className="fill-[oklch(0.5_0.1_20)]"'],
    ['a typed arbitrary colour', 'className="text-[color:var(--x)]"'],
    ['an arbitrary variable that is not ours', 'className="bg-[var(--color-red-500)]"'],
    ['an arbitrary colour under a variant', 'className="dark:bg-[#000]"'],
    ['a hex literal in code', "const c = '#a1b2c3';"],
    ['a short hex literal', "const c = '#abc';"],
    ['an rgba literal', "const c = 'rgba(0,0,0,0.5)';"],
    ['an oklab literal', "const c = 'oklab(0.5 0 0)';"],
    ['an inline colour', 'style={{ color: "red" }}'],
    ['an inline background colour', 'style={{ backgroundColor: x }}'],
    ['an inline border colour', 'style={{ borderTopColor: x }}'],
    ['an inline fill', 'style={{ width: 1, fill: x }}'],
    ['an inline shorthand background', 'style={{ background: x }}'],
  ];
  it.each(FLAGGED)('flags %s', (_name, text) => {
    expect(colourOffences(text).length).toBeGreaterThan(0);
  });

  const ALLOWED: [string, string][] = [
    ['a design-token colour', 'className="bg-ih-bg-card text-ih-fg-1 border-ih-border"'],
    ['a design-token colour with an opacity and a variant', 'className="hover:bg-ih-bad/80 dark:text-ih-fg-2"'],
    ['a side border token', 'className="border-l-4 border-l-ih-bad"'],
    ['a transparent border, the one allowed', 'className="border border-transparent"'],
    ['a token shadow and focus ring', 'className="shadow-ih-card focus-visible:shadow-ih-focus"'],
    ['an arbitrary value that is not a colour', 'className="[overflow-wrap:anywhere] w-[calc(100%-1rem)] text-[length:var(--ih-size)]"'],
    ['an inline style that is not a colour', 'style={{ width: 4, height: 8 }}'],
    ['a hash that is not a colour', 'const n = "item #12";'],
    ['a word that merely contains a palette name', 'className="bg-ih-redacted"'],
  ];
  it.each(ALLOWED)('allows %s', (_name, text) => {
    expect(colourOffences(text)).toEqual([]);
  });
});
