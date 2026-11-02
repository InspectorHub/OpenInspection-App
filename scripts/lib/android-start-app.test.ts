import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * CI run 41417726030: the app was started, Maestro was handed a blank window, and 60 s later the launcher was in front with no trace of why.
 * `start_app` now waits for the app's first screen by its text and starts the app again when it does not come. adb is stubbed (the same
 * stand-in the whole-script Android tests use), so this checks the waiting, the relaunch and the evidence, not an emulator.
 */
const ROOT = join(__dirname, '..', '..');
const STUBS = join(__dirname, 'fixtures', 'android-stubs');
const DIALOG = join(__dirname, 'fixtures', 'anr-pixel-launcher.ui.xml');
const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const screen = (text: string): string => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="${text}" resource-id="" class="android.widget.TextView" package="io.inspectorhub.app" bounds="[0,0][1080,200]" /></hierarchy>`;

interface Result { status: number | null; out: string; calls: string[]; files: string[] }

function run(pattern: string, sequence: string, extra: Record<string, string> = {}, attempts = '3', twice = false): Result {
  const base = mkdtempSync(join(tmpdir(), 'android-start-app-test-'));
  dirs.push(base);
  const [state, bin, xml, out] = ['state', 'bin', 'xml', 'out'].map((name) => join(base, name)) as [string, string, string, string];
  for (const d of [state, bin, xml, out]) mkdirSync(d);
  for (const name of ['adb', 'sleep']) {
    copyFileSync(join(STUBS, `${name}.sh`), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  copyFileSync(DIALOG, join(xml, 'dialog.xml'));
  writeFileSync(join(xml, 'app.xml'), screen('Choose your server'));
  writeFileSync(join(xml, 'list.xml'), screen('Work list'));
  writeFileSync(join(xml, 'blank.xml'), screen(''));
  const unix = (p: string): string => p.replaceAll('\\', '/');
  const script = `set -Eeuo pipefail
fail() { echo "::error::$*"; return 1; }
APP_ID=io.inspectorhub.app
OUT="${unix(out)}"
. "${unix(join(ROOT, 'scripts', 'lib', 'dismiss-not-responding.sh'))}"
. "${unix(join(ROOT, 'scripts', 'lib', 'android-start-app.sh'))}"
start_app '${pattern}' ${attempts}
${twice ? `echo FIRST-DONE\nstart_app '${pattern}' ${attempts}\n` : ''}echo STARTED`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, STATE: unix(state), XML_DIR: unix(xml), UI_SEQUENCE: sequence, START_SCREEN_SECONDS: '0', ...extra },
  });
  let calls: string[] = [];
  try { calls = readFileSync(join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, files: readdirSync(out) };
}
const launches = (calls: string[]): number => calls.filter((c) => c.startsWith('adb shell am start')).length;
const stops = (calls: string[]): number => calls.filter((c) => c.startsWith('adb shell am force-stop')).length;

describe.skipIf(!bashAvailable)('start_app', () => {
  it('starts the app once and goes on when the first screen is there at once', () => {
    const r = run('Choose your server', 'app');
    expect(r.status).toBe(0);
    expect(r.out).toContain('STARTED');
    expect(launches(r.calls)).toBe(1);
    expect(stops(r.calls)).toBe(0);
    expect(r.out).not.toContain('::warning::');
  });

  it('a blank window is not the first screen: it stops the app and starts it again, says so, and keeps what it saw', () => {
    const r = run('Choose your server', 'blank,app');
    expect(r.status).toBe(0);
    expect(launches(r.calls)).toBe(2);
    expect(stops(r.calls)).toBe(1);
    expect(r.out).toContain('::warning::the app did not show "Choose your server"');
    expect(r.out).toContain('::warning::the app needed 2 launches');
    expect(r.files).toContain('first-screen-attempt-1.png');
    expect(r.files).toContain('first-screen-attempt-1.xml');
  });

  it('gives up after the given number of launches, with an error and a non-zero status (control: it does not pass on a screen that never comes)', () => {
    const r = run('Choose your server', 'blank', {}, '3');
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('STARTED');
    expect(launches(r.calls)).toBe(3);
    expect(r.out).toContain('::error::the app did not show "Choose your server" in 3 launches');
  });

  it('a system "isn\'t responding" dialog in front is dismissed with Wait while it waits, and the screen behind it then counts', () => {
    const r = run('Choose your server', 'dialog,app', { START_SCREEN_SECONDS: '10' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('adb shell input tap 540 1359');
    expect(launches(r.calls)).toBe(1); // it waited, it did not restart the app
  });

  it('accepts either of two alternatives (after a restart the work list, or the app\'s own offer to show upload progress)', () => {
    expect(run('Work list|Show upload progress', 'list').status).toBe(0);
    expect(run('Work list|Show upload progress', 'app').status).not.toBe(0);
  });

  it('an old dump is never read as the new one: a second start whose dumps all fail does not pass on the first start\'s screen', () => {
    // The first start sees the app (one good dump). From then on dumps fail and write nothing. Without the removal of the old file the second
    // start would read the first one's screen, match, and pass. It must fail after its launches.
    const r = run('Choose your server', 'app', { DUMP_FAILS_AFTER: '1' }, '2', true);
    expect(r.out).toContain('FIRST-DONE');
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('STARTED');
    expect(r.out).toContain('::error::the app did not show "Choose your server" in 2 launches');
    // Control: with dumps that keep working the same two starts both pass.
    expect(run('Choose your server', 'app', {}, '2', true).status).toBe(0);
  });
});
