import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname);

const FORMATTER = /\bIntl\s*\.\s*(?:DateTimeFormat|RelativeTimeFormat|NumberFormat|ListFormat|PluralRules|DisplayNames|Collator|Segmenter)\s*\(\s*([^,)]*)/g;
const TO_LOCALE = /\.\s*toLocale\w*\s*\(\s*([^,)]*)/g;
const BRACKET_TO_LOCALE = /\[\s*['"`]toLocale\w*['"`]\s*\]\s*\(\s*([^,)]*)/g;
const NAMES = /(?:DateTimeFormat|RelativeTimeFormat|NumberFormat|ListFormat|PluralRules|DisplayNames|Collator|Segmenter)/.source;
/** Ways to reach a formatter without a call this scan can read: an alias, a destructuring, a bracket lookup, a stored method. */
const ESCAPES: [string, RegExp][] = [
  ['aliases an Intl formatter', new RegExp(String.raw`(?<![:<]\s*)(?<!\bas\s+)\bIntl\s*\.\s*${NAMES}\b(?!\s*\()`)],
  ['destructures an Intl formatter', new RegExp(String.raw`\{[^}]*\b${NAMES}\b[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?Intl\b`)],
  ['looks an Intl member up by name', /\bIntl\s*\[/],
  ['stores a toLocale method without calling it', /\.\s*toLocale\w*(?!\w|\s*\()/],
];
const DEVICE_LANGUAGE = /\bnavigator\s*\??\.\s*languages?\b/;

/** Comments are prose, and prose may name the very calls this test hunts for. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Every place a formatting call takes its locale from somewhere other than the interface language: no locale at all (the
 * device's wins), the device language read directly, or a locale that is not `FORMAT_LOCALE` or a parameter named `locale`
 * in a file that imports `FORMAT_LOCALE` (where that parameter defaults to it).
 */
function localeViolations(source: string): string[] {
  const code = withoutComments(source);
  const imports = /\bFORMAT_LOCALE\b/.test(code);
  const found: string[] = [];
  for (const pattern of [FORMATTER, TO_LOCALE, BRACKET_TO_LOCALE]) {
    for (const match of code.matchAll(pattern)) {
      const first = (match[1] ?? '').trim();
      const fromInterface = first === 'FORMAT_LOCALE' || (first === 'locale' && imports);
      if (!fromInterface) found.push(`${match[0].trim()} (first argument: ${first === '' ? 'none' : first})`);
    }
  }
  for (const [what, pattern] of ESCAPES) if (pattern.test(code)) found.push(what);
  if (DEVICE_LANGUAGE.test(code)) found.push('reads navigator.language');
  return found;
}

/** The one helper that stubs the device locale on purpose, so a test can prove the screens do not follow it. */
const STUBS = ['default-locale.ts'];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sources(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'schema.d.ts' && !STUBS.includes(name)) out.push(full);
  }
  return out;
}

const callCount = (source: string): number => [FORMATTER, TO_LOCALE, BRACKET_TO_LOCALE].reduce((n, pattern) => n + [...withoutComments(source).matchAll(pattern)].length, 0);

describe('formatting takes its locale from the interface language', () => {
  it('no source formats with the device locale', () => {
    const files = sources(SRC);
    const offenders = files.flatMap((file) => localeViolations(readFileSync(file, 'utf8')).map((v) => `${relative(SRC, file).split(sep).join('/')}: ${v}`));
    const calls = files.reduce((n, file) => n + callCount(readFileSync(file, 'utf8')), 0);
    // Both numbers: a scan that finds no calls at all is blind, not clean.
    expect({ filesScanned: files.length > 50, formattingCallsSeen: calls >= 3, testSupportScanned: files.some((f) => /test-support[\\/]/.test(f)) }).toEqual({ filesScanned: true, formattingCallsSeen: true, testSupportScanned: true });
    expect(offenders).toEqual([]);
  });

  it('control: the central formatter file is clean and its calls are seen', () => {
    const source = readFileSync(join(SRC, 'ui/worklist/format.ts'), 'utf8');
    expect(callCount(source)).toBeGreaterThanOrEqual(3);
    expect(localeViolations(source)).toEqual([]);
    expect(localeViolations(readFileSync(join(SRC, 'platform/format-locale.ts'), 'utf8'))).toEqual([]);
  });

  it.each([
    ['no locale', 'new Intl.DateTimeFormat(undefined, {})'],
    ['an empty call', 'new Intl.RelativeTimeFormat()'],
    ['a literal locale', "new Intl.NumberFormat('de-DE')"],
    ['toLocaleString without a locale', 'date.toLocaleString()'],
    ['toLocaleDateString with undefined', 'date.toLocaleDateString(undefined, { month: "long" })'],
    ['the device language', 'const l = navigator.language;'],
    ['a destructured formatter', 'const { DateTimeFormat } = Intl; new DateTimeFormat();'],
    ['a destructured formatter through globalThis', 'const { RelativeTimeFormat: R } = globalThis.Intl;'],
    ['an aliased formatter', 'const F = Intl.DateTimeFormat; new F();'],
    ['a bracket lookup on Intl', "new Intl['DateTimeFormat']()"],
    ['a bracket toLocale call without a locale', "date['toLocaleString']()"],
    ['a bracket toLocale call with undefined', 'date["toLocaleDateString"](undefined, {})'],
    ['a stored toLocale method', 'const f = date.toLocaleString; f.call(date);'],
    ['a parameter named locale in a file that never imports FORMAT_LOCALE', 'function f(locale: string) { return new Intl.DateTimeFormat(locale); }'],
  ])('flags %s', (_name, source) => {
    expect(localeViolations(source)).not.toEqual([]);
  });

  it.each([
    ['the central constant', "import { FORMAT_LOCALE } from './x'; new Intl.DateTimeFormat(FORMAT_LOCALE, {})"],
    ['a locale parameter in a file that imports the constant', "import { FORMAT_LOCALE } from './x'; function f(locale = FORMAT_LOCALE) { return new Intl.NumberFormat(locale); }"],
    ['toLocaleString with the constant', "import { FORMAT_LOCALE } from './x'; date.toLocaleString(FORMAT_LOCALE)"],
    ['a bracket toLocale call with the constant', "import { FORMAT_LOCALE } from './x'; date['toLocaleString'](FORMAT_LOCALE)"],
    ['a type position (not a use)', 'let f: Intl.DateTimeFormat; const g = h as Intl.RelativeTimeFormat; const k: Array<Intl.NumberFormat> = [];'],
    ['a call named only in a comment', '// new Intl.DateTimeFormat() would be wrong\nconst x = 1;'],
  ])('control: accepts %s', (_name, source) => {
    expect(localeViolations(source)).toEqual([]);
  });
});
