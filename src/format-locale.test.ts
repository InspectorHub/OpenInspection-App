import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname);

const FORMATTER = /\bIntl\s*\.\s*(?:DateTimeFormat|RelativeTimeFormat|NumberFormat|ListFormat|PluralRules|DisplayNames|Collator|Segmenter)\s*\(\s*([^,)]*)/g;
const TO_LOCALE = /\.\s*toLocale\w*\s*\(\s*([^,)]*)/g;
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
  for (const pattern of [FORMATTER, TO_LOCALE]) {
    for (const match of code.matchAll(pattern)) {
      const first = (match[1] ?? '').trim();
      const fromInterface = first === 'FORMAT_LOCALE' || (first === 'locale' && imports);
      if (!fromInterface) found.push(`${match[0].trim()} (first argument: ${first === '' ? 'none' : first})`);
    }
  }
  if (DEVICE_LANGUAGE.test(code)) found.push('reads navigator.language');
  return found;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'test-support') continue;
      sources(full, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && name !== 'schema.d.ts') out.push(full);
  }
  return out;
}

const callCount = (source: string): number => [FORMATTER, TO_LOCALE].reduce((n, pattern) => n + [...withoutComments(source).matchAll(pattern)].length, 0);

describe('formatting takes its locale from the interface language', () => {
  it('no source formats with the device locale', () => {
    const files = sources(SRC);
    const offenders = files.flatMap((file) => localeViolations(readFileSync(file, 'utf8')).map((v) => `${relative(SRC, file).split(sep).join('/')}: ${v}`));
    const calls = files.reduce((n, file) => n + callCount(readFileSync(file, 'utf8')), 0);
    // Both numbers: a scan that finds no calls at all is blind, not clean.
    expect({ filesScanned: files.length > 50, formattingCallsSeen: calls >= 3 }).toEqual({ filesScanned: true, formattingCallsSeen: true });
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
    ['a parameter named locale in a file that never imports FORMAT_LOCALE', 'function f(locale: string) { return new Intl.DateTimeFormat(locale); }'],
  ])('flags %s', (_name, source) => {
    expect(localeViolations(source)).not.toEqual([]);
  });

  it.each([
    ['the central constant', "import { FORMAT_LOCALE } from './x'; new Intl.DateTimeFormat(FORMAT_LOCALE, {})"],
    ['a locale parameter in a file that imports the constant', "import { FORMAT_LOCALE } from './x'; function f(locale = FORMAT_LOCALE) { return new Intl.NumberFormat(locale); }"],
    ['toLocaleString with the constant', "import { FORMAT_LOCALE } from './x'; date.toLocaleString(FORMAT_LOCALE)"],
    ['a call named only in a comment', '// new Intl.DateTimeFormat() would be wrong\nconst x = 1;'],
  ])('control: accepts %s', (_name, source) => {
    expect(localeViolations(source)).toEqual([]);
  });
});
