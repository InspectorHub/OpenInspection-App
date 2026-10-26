import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'sync-ios-version.mjs');
const PROJECT = join('ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
const project = readFileSync(join(ROOT, PROJECT), 'utf8');
const plist = readFileSync(join(ROOT, 'ios', 'App', 'App', 'Info.plist'), 'utf8');

/** iOS takes major.minor.patch only, so a pre-release suffix is dropped. */
const marketing = pkg.version.replace(/-.*$/, '');
const settings = (text: string, name: string): string[] => [...text.matchAll(new RegExp(String.raw`^\s*${name} = ([^;]*);$`, 'gm'))].map((m) => m[1] ?? '');

describe('the iOS version follows package.json', () => {
  it('every MARKETING_VERSION in the project equals the package.json version (a second hard-coded number would drift)', () => {
    const found = settings(project, 'MARKETING_VERSION');
    expect(found).toHaveLength(2); // Debug and Release; none would pass the next line for the wrong reason
    for (const value of found) expect(value).toBe(marketing);
  });

  it('the Info.plist takes both numbers from the build settings, with no literal of its own', () => {
    expect(plist).toMatch(/<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/);
    expect(plist).toMatch(/<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/);
  });

  it('the package.json version has the form the release rules need', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});

describe('scripts/sync-ios-version.mjs', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(version: string, text: string = project): string {
    const dir = mkdtempSync(join(tmpdir(), 'ios-version-'));
    made.push(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
    mkdirSync(join(dir, 'ios', 'App', 'App.xcodeproj'), { recursive: true });
    writeFileSync(join(dir, PROJECT), text);
    return dir;
  }

  const run = (dir: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, '--root', dir, ...args], { encoding: 'utf8' });

  it('check passes when the project matches and fails when a literal differs (control: both outcomes)', () => {
    expect(run(fixture(marketing), '--check').status).toBe(0);
    const stale = project.replace(`MARKETING_VERSION = ${marketing};`, 'MARKETING_VERSION = 9.9.9;');
    expect(stale).not.toBe(project);
    const result = run(fixture(marketing, stale), '--check');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('other than');
  });

  it('writes the version and the build number, drops a pre-release suffix, and a second run changes nothing', () => {
    const dir = fixture('2.3.4-rc.1');
    expect(run(dir, '--build-number', '57').status).toBe(0);
    const written = readFileSync(join(dir, PROJECT), 'utf8');
    expect(settings(written, 'MARKETING_VERSION')).toEqual(['2.3.4', '2.3.4']);
    expect(settings(written, 'CURRENT_PROJECT_VERSION')).toEqual(['57', '57']);
    expect(run(dir, '--build-number', '57').status).toBe(0);
    expect(readFileSync(join(dir, PROJECT), 'utf8')).toBe(written);
    expect(run(dir, '--check').status).toBe(0);
  });

  it.each(['0', '007', 'abc', '', '1000000000', '-1'])('refuses the build number %j', (value) => {
    const result = run(fixture(marketing), '--build-number', value);
    expect(result.status).toBe(1);
    expect(readFileSync(join(made[made.length - 1] ?? '', PROJECT), 'utf8')).toBe(project);
  });

  it.each(['1.2', '1.2.3.4', 'v1.2.3', '1.2.3+build'])('refuses the package.json version %j', (version) => {
    expect(run(fixture(version)).status).toBe(1);
  });

  it('refuses a project that does not have exactly two MARKETING_VERSION settings', () => {
    expect(run(fixture(marketing, project.replace(/^\s*MARKETING_VERSION = [^;]*;\n/m, '')), '--check').status).toBe(1);
  });

  it('works on a project with CRLF line endings and keeps them (the optional CR is captured, not dropped)', () => {
    const crlf = project.replace(/\n/g, '\r\n');
    expect(crlf).not.toBe(project);
    const stale = crlf.replace(`MARKETING_VERSION = ${marketing};`, 'MARKETING_VERSION = 9.9.9;');
    const dir = fixture(marketing, stale);
    expect(run(dir, '--check').status).toBe(1);
    expect(run(dir, '--build-number', '8').status).toBe(0);
    const written = readFileSync(join(dir, PROJECT), 'utf8');
    expect(written).toBe(crlf.replace(/CURRENT_PROJECT_VERSION = [^;]*;/g, 'CURRENT_PROJECT_VERSION = 8;'));
    expect(written.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
    expect(run(dir, '--check').status).toBe(0);
  });

  it('control: the fixture helper copies the real project, so the checks above ran against it', () => {
    const dir = fixture(marketing);
    cpSync(join(dir, PROJECT), join(dir, 'copy'));
    expect(readFileSync(join(dir, 'copy'), 'utf8')).toBe(project);
  });
});
