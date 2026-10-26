import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'check-release-bundle.mjs');
const made: string[] = [];

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-bundle-'));
  made.push(dir);
  for (const [name, text] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

function check(dir: string) {
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check-release-bundle', () => {
  it('fails on a bundle that still contains the plain-http toggle label', () => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'x("Allow plain http (development only)")' });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Allow plain http');
  });

  it('fails on a bundle that still contains the diagnostics button label', () => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'x("Diagnostics (development only)")' });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Diagnostics (development only)');
  });

  it('fails on a bundle that still contains a check title marker, even in a lazy chunk', () => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'x("Continue")', 'assets/diagnostics-def.js': 'y("[diag] db-blob: binary values")' });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('diagnostics-def.js');
    expect(result.stderr).toContain('[diag]');
  });

  it('fails on a console line template that carries the marker', () => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'console.info(`[diag] ${id} ${ok} ${detail}`)' });
    expect(check(dir).status).toBe(1);
  });

  it.each(['issuePlanForTest', 'purgeAuthorityForTest', 'neverBlocked'])('fails on a bundle that carries the test-support name %s, even in a lazy chunk', (name) => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'x("Continue")', 'assets/lazy-def.js': `export{${name} as a}` });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lazy-def.js');
    expect(result.stderr).toContain(name);
  });

  it.each(['Seed demo data', 'Remove demo data', 'diag-quarantined'])('fails on a bundle that carries the demo-data seed (%s), even in a lazy chunk', (needle) => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'x("Continue")', 'assets/seed-def.js': `y("${needle}")` });
    const result = check(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('seed-def.js');
    expect(result.stderr).toContain(needle);
  });

  it('control: names that merely resemble the test-support ones pass', () => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'issuePlan(); purgeAuthority(); isBlocked(); neverBlock()' });
    expect(check(dir).status).toBe(0);
  });

  it('control: a bundle with similar but allowed words passes', () => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'x("Diagnostics are off"); y("diag"); z("[diagram]")' });
    expect(check(dir).status).toBe(0);
  });

  it('control: passes on a bundle without it, and says how many files it scanned', () => {
    const dir = fixture({ 'index.html': '<html></html>', 'assets/index-abc.js': 'x("Continue")' });
    const result = check(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('scanned 2 files, 0 forbidden strings found');
  });

  it('an empty or missing directory is an error, not a pass', () => {
    expect(check(fixture({ 'notes.txt': 'nothing built' })).status).toBe(2);
    expect(check(join(tmpdir(), 'release-bundle-does-not-exist')).status).toBe(2);
  });
});
