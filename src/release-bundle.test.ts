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
