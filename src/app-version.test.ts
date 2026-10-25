import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

const ROOT = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const compose = readFileSync(join(ROOT, 'src', 'app', 'compose.ts'), 'utf8');

/** Comments are prose: a rule that only appears in one must not satisfy a check. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const gradle = withoutComments(readFileSync(join(ROOT, 'android', 'app', 'build.gradle'), 'utf8'));

/** The `defaultConfig` block of the build file. */
function defaultConfig(text: string): string {
  const start = text.indexOf('defaultConfig');
  return text.slice(start, text.indexOf('testInstrumentationRunner', start));
}

/** The first regular-expression literal that follows `operator` in the build file, as a JavaScript RegExp (the syntax is the same for these patterns). */
function groovyPattern(operator: '=~' | '==~'): RegExp {
  const match = new RegExp(`${operator}\\s*/(.+?)/\\)`).exec(gradle);
  if (match?.[1] === undefined) throw new Error(`no ${operator} pattern in build.gradle`);
  return new RegExp(match[1]);
}

const VERSION = groovyPattern('=~');
/** Groovy's `==~` must match the whole string; a JavaScript pattern is anchored to say the same. */
const OVERRIDE = new RegExp(`^(?:${groovyPattern('==~').source})$`);

const MAX_CODE = 2_100_000_000;

/**
 * A JavaScript mirror of the version arithmetic in `android/app/build.gradle` (the build file is the authority; the text tests
 * below pin its formula and guards, and this mirror lets the properties be checked over a whole grid): the version code is
 * major * 1000000 + minor * 1000 + patch, never below 1, and a version that does not fit is refused, as the build file does.
 */
function mirror(version: string): number | null {
  const match = VERSION.exec(version);
  if (match === null) return null;
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (major > 2100 || minor >= 1000 || patch >= 1000) return null;
  const derived = major * 1_000_000 + minor * 1000 + patch;
  return derived > MAX_CODE ? null : Math.max(1, derived);
}

describe('one version, from package.json', () => {
  it('the web bundle gets it as __APP_VERSION__, which is what the X-Client-Version header and Settings show', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.define?.__APP_VERSION__).toBe(JSON.stringify(pkg.version));
    expect(compose).toContain('appVersion: __APP_VERSION__');
    expect(compose).toContain("'X-Client-Version': appVersion");
  });

  it('the Android versionName is the whole string read from package.json, not written in the build file', () => {
    const block = defaultConfig(gradle);
    expect(gradle).toContain("new groovy.json.JsonSlurper().parse(file('../../package.json'))");
    expect(gradle).toMatch(/^def appVersionName = appVersionText$/m);
    expect(block).toMatch(/versionName\s+appVersionName\s*$/m);
    expect(block).not.toMatch(/versionName\s+["']/);
  });

  it('the versionCode is major * 1000000 + minor * 1000 + patch, at least 1, or an explicit one', () => {
    const block = defaultConfig(gradle);
    expect(gradle).toContain('def derived = appMajor * 1000000 + appMinor * 1000 + appPatch');
    expect(gradle).toContain('appVersionCodeValue = Math.max(1, derived.intValue())');
    expect(gradle).toContain("project.hasProperty('appVersionCode')");
    expect(block).toMatch(/versionCode\s+appVersionCodeValue\s*$/m);
    expect(block).not.toMatch(/versionCode\s+\d/);
  });

  it('every guard is in the build file and stops the build with a message', () => {
    expect(gradle).toContain("if (!(appVersionText instanceof String)) {");
    expect(gradle).toContain('if (!appVersionMatch.matches()) {');
    expect(gradle).toContain('if (appMajor > 2100 || appMinor >= 1000 || appPatch >= 1000) {');
    expect(gradle).toContain('if (derived > 2100000000) {');
    expect(gradle).toContain('if (!(requested ==~ /[1-9][0-9]{0,9}/) || requested.toLong() > 2100000000L) {');
    expect(gradle.match(/throw new GradleException\(/g)?.length).toBe(5);
    expect(gradle).not.toMatch(/\.toInteger\(\)/);
  });

  it('the two patterns in the build file are the ones this test runs (control: they are not empty and not trivially true)', () => {
    expect(VERSION.source).toBe('^(\\d+)\\.(\\d+)\\.(\\d+)(?:-[0-9A-Za-z.-]+)?$');
    expect(OVERRIDE.source).toBe('^(?:[1-9][0-9]{0,9})$');
  });
});

describe('the version pattern', () => {
  it.each(['0.0.0', '1.2.3', '12.345.678', '1.2.3-beta.1', '1.2.3-rc-2'])('accepts %s', (version) => {
    expect(VERSION.test(version)).toBe(true);
  });

  it.each(['1.2.3abc', '1.2.3.4', '1.2', '1.2.3-', '1.2.3+build', ' 1.2.3', '1.2.3\n', 'v1.2.3', '', '1.2.x'])('rejects %j', (version) => {
    expect(VERSION.test(version)).toBe(false);
  });
});

describe('an explicit version code', () => {
  it.each(['1', '2', '1000000', '2100000000', '999999999'])('accepts %s', (code) => {
    expect(OVERRIDE.test(code)).toBe(true);
    expect(Number(code)).toBeLessThanOrEqual(MAX_CODE);
  });

  it.each(['0', '-1', '007', '01', '', ' 5', '5 ', '1.5', 'abc', '1e3', '12345678901'])('rejects %j', (code) => {
    expect(OVERRIDE.test(code)).toBe(false);
  });

  it('control: a number the pattern accepts but the range check refuses (2100000001) is caught by the second half of the guard', () => {
    expect(OVERRIDE.test('2100000001')).toBe(true);
    expect(Number('2100000001') > MAX_CODE).toBe(true);
    expect(gradle).toContain('requested.toLong() > 2100000000L');
  });
});

describe('the version code', () => {
  it('examples', () => {
    expect(mirror('0.0.0')).toBe(1);
    expect(mirror('0.0.1')).toBe(1);
    expect(mirror('0.0.2')).toBe(2);
    expect(mirror('0.1.0')).toBe(1000);
    expect(mirror('1.0.0')).toBe(1_000_000);
    expect(mirror('1.2.3')).toBe(1_002_003);
    expect(mirror('1.2.3-beta.1')).toBe(1_002_003);
    expect(mirror('1.100.0')).toBe(1_100_000);
    expect(mirror('2.0.0')).toBe(2_000_000);
    expect(mirror(pkg.version)).toBeGreaterThanOrEqual(1);
  });

  it('1.100.0 and 2.0.0, and 1.0.100 and 1.1.0, no longer collide (the old formula gave them the same code)', () => {
    expect(mirror('1.100.0')).not.toBe(mirror('2.0.0'));
    expect(mirror('1.0.100')).not.toBe(mirror('1.1.0'));
    expect(1 * 10_000 + 100 * 100 + 0).toBe(2 * 10_000);
  });

  it('is different for every version on a grid, and rises with the version (a later version is never refused for a lower code)', () => {
    const parts = [0, 1, 2, 9, 10, 99, 100, 101, 998, 999];
    const majors = [0, 1, 2, 3, 99, 100, 999, 2099];
    const seen = new Map<number, string>();
    let previous = 0;
    for (const major of majors) {
      for (const minor of parts) {
        for (const patch of parts) {
          // 0.0.0 is the placeholder version and shares the lowest code (1) with 0.0.1; every other version has its own.
          if (major === 0 && minor === 0 && patch === 0) continue;
          const version = `${String(major)}.${String(minor)}.${String(patch)}`;
          const code = mirror(version);
          expect(code, version).not.toBeNull();
          if (code === null) continue;
          expect(seen.get(code), `${version} collides`).toBeUndefined();
          seen.set(code, version);
          expect(code, version).toBeGreaterThan(previous);
          previous = code;
        }
      }
    }
    expect(seen.size).toBe(majors.length * parts.length * parts.length - 1);
  });

  it('refuses what does not fit rather than wrapping or colliding', () => {
    expect(mirror('0.1000.0')).toBeNull();
    expect(mirror('0.0.1000')).toBeNull();
    expect(mirror('2101.0.0')).toBeNull();
    expect(mirror('2100.0.1')).toBeNull();
    expect(mirror('2100.0.0')).toBe(MAX_CODE);
    expect(mirror('1.2.3abc')).toBeNull();
    expect(mirror('1.2.3.4')).toBeNull();
    expect(mirror('99999999999999999999.0.0')).toBeNull();
  });
});
