import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// This repository is public and English-only. The ranges are numeric code points so this file
// itself stays free of the characters it hunts for.
const RANGES: [number, number][] = [
  [0x3000, 0x30ff], // CJK punctuation, Hiragana, Katakana
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xff00, 0xffef], // half- and full-width forms
  [0xac00, 0xd7af], // Hangul syllables
];
const ROOT = join(import.meta.dirname, '..');
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.json']);

function hasCjk(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)) return true;
  }
  return false;
}

function walk(dir: string, out: string[]): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(name.slice(name.lastIndexOf('.')))) out.push(full);
  }
  return out;
}

function offenders(files: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (hasCjk(line)) found.push(`${relative(ROOT, file).split(sep).join('/')}:${String(index + 1)}`);
    });
  }
  return found;
}

describe('the public repository stays English-only', () => {
  const files = [...walk(join(ROOT, 'src'), []), ...walk(join(ROOT, 'scripts'), [])];

  it('scans a real set of files (the scan is not vacuously empty)', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('positive control: the first and last code point of every range is recognised', () => {
    for (const [lo, hi] of RANGES) {
      expect(hasCjk(`a ${String.fromCodePoint(lo)} b`), lo.toString(16)).toBe(true);
      expect(hasCjk(`a ${String.fromCodePoint(hi)} b`), hi.toString(16)).toBe(true);
    }
  });

  it('negative control: code points just outside the ranges, Latin accents and emoji are not flagged', () => {
    for (const [lo, hi] of RANGES) {
      expect(hasCjk(String.fromCodePoint(lo - 1)), `before ${lo.toString(16)}`).toBe(false);
      expect(hasCjk(String.fromCodePoint(hi + 1)), `after ${hi.toString(16)}`).toBe(false);
    }
    expect(hasCjk('Zażółć café 😀 — →')).toBe(false);
  });

  it('no source, script or test file contains CJK text', () => {
    expect(offenders(files)).toEqual([]);
  });
});
