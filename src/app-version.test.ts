import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

const ROOT = join(import.meta.dirname, '..');
const gradle = readFileSync(join(ROOT, 'android', 'app', 'build.gradle'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const compose = readFileSync(join(ROOT, 'src', 'app', 'compose.ts'), 'utf8');

/** The `defaultConfig` block, comments removed, so a commented-out line cannot satisfy a check. */
function defaultConfig(text: string): string {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const start = code.indexOf('defaultConfig');
  return code.slice(start, code.indexOf('testInstrumentationRunner', start));
}

/** The versionCode the build file's formula gives for `version`, evaluated here the way the build file writes it. */
function derivedCode(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) throw new Error('not a version');
  return Math.max(1, Number(match[1]) * 10_000 + Number(match[2]) * 100 + Number(match[3]));
}

describe('one version, from package.json', () => {
  it('the web bundle gets it as __APP_VERSION__, which is what the X-Client-Version header and Settings show', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(config.define?.__APP_VERSION__).toBe(JSON.stringify(pkg.version));
    expect(compose).toContain('appVersion: __APP_VERSION__');
    expect(compose).toContain("'X-Client-Version': appVersion");
  });

  it('the Android versionName is read from package.json, not written in the build file', () => {
    const block = defaultConfig(gradle);
    expect(gradle).toMatch(/JsonSlurper/);
    expect(gradle).toMatch(/\.\.\/\.\.\/package\.json/);
    expect(block).toMatch(/versionName\s+appVersionName/);
    expect(block).not.toMatch(/versionName\s+["']/);
  });

  it('the versionCode is major*10000 + minor*100 + patch, and a release can pass one explicitly', () => {
    const block = defaultConfig(gradle);
    expect(gradle).toMatch(/\*\s*10000/);
    expect(gradle).toMatch(/\*\s*100\b/);
    expect(gradle).toMatch(/hasProperty\('appVersionCode'\)/);
    expect(block).toMatch(/versionCode\s+appVersionCodeValue/);
    expect(block).not.toMatch(/versionCode\s+\d/);
  });

  it('a version that is not major.minor.patch stops the build instead of shipping a wrong number', () => {
    expect(gradle).toMatch(/GradleException/);
  });

  it('control: the formula orders releases (1.2.3 < 1.10.0 < 2.0.0) and the current version gives a positive code', () => {
    expect(derivedCode('1.2.3')).toBe(10_203);
    expect(derivedCode('1.2.3')).toBeLessThan(derivedCode('1.10.0'));
    expect(derivedCode('1.10.0')).toBeLessThan(derivedCode('2.0.0'));
    expect(derivedCode('1.2.3-rc.1')).toBe(10_203);
    expect(derivedCode('0.0.0')).toBe(1);
    expect(derivedCode(pkg.version)).toBeGreaterThanOrEqual(1);
  });
});
