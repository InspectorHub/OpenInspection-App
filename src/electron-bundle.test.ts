import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
const root = resolve('scripts/check-electron-bundle.mjs');
function fixture(text?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'oi-electron-bundle-'));
  temporary.push(dir);
  if (text !== undefined) writeFileSync(join(dir, 'entry.js'), text);
  return dir;
}
function check(path: string) { return spawnSync(process.execPath, [root, path], { encoding: 'utf8' }); }
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('Electron bundle boundary', () => {
  it.each(['@capacitor/core', 'Capacitor.getPlatform()', 'capacitor://localhost', 'Diagnostics (development only)', 'Seed demo data', 'neverBlocked'])(
    'rejects forbidden renderer marker %s', (marker) => {
      const result = check(fixture(`/* ${marker} */`));
      expect(result.status).toBe(1);
      expect(result.stderr.toLowerCase()).toContain(marker.toLowerCase().slice(0, marker === '@capacitor/core' ? 10 : marker === 'Capacitor.getPlatform()' ? 10 : marker === 'capacitor://localhost' ? 12 : marker.length));
    },
  );

  it('fails on an empty scan rather than passing vacuously', () => {
    const result = check(fixture());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('nothing was checked');
  });

  it('accepts an ordinary renderer file', () => {
    expect(check(fixture('renderer-ready')).status).toBe(0);
  });

  it('rejects an Android renderer fixture containing the Capacitor runtime', () => {
    const androidBundle = fixture('/* generated Android renderer: @capacitor/core; Capacitor.getPlatform() */');
    const result = check(androidBundle);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('contains "@capacitor"');
  });
});
