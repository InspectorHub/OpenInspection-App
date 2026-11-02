import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The two Android emulator scripts are run WHOLE, with a stand-in adb, maestro and sleep first on PATH (source in fixtures/android-stubs),
 * and what is asserted is what they did: which adb calls, in which order, with which result. What this cannot show is how a real emulator
 * behaves: that is what the CI job shows. The dialog's real uiautomator tree is the fixture of CI run 41367506059.
 */
// Every call to a stand-in is a process, and a hosted Windows runner starts them slowly: a whole-script run took 40 s there and 8 s here.
vi.setConfig({ testTimeout: 120_000 });
const ROOT = resolve(__dirname, '..', '..');
// How many looks the smoke script takes before it gives up (its default is 15; fewer here, because each look costs several processes).
const LOOKS = 3;
const STUBS = join(__dirname, 'fixtures', 'android-stubs');
const DIALOG = join(__dirname, 'fixtures', 'anr-pixel-launcher.ui.xml');
const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const APP_XML = '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0"><node index="0" text="Choose your server" resource-id="" class="android.widget.TextView" package="io.inspectorhub.app" bounds="[0,0][1080,200]" /></hierarchy>';
const BLANK_XML = '<?xml version=\'1.0\' encoding=\'UTF-8\' standalone=\'yes\' ?><hierarchy rotation="0"><node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="io.inspectorhub.app" bounds="[0,0][1080,2400]" /></hierarchy>';
const FATAL_APP = 'E AndroidRuntime: FATAL EXCEPTION: main\nE AndroidRuntime: Process: io.inspectorhub.app, PID: 1234\nE AndroidRuntime: java.lang.IllegalStateException';
const FATAL_TOOLING = 'E AndroidRuntime: FATAL EXCEPTION: UiAutomation\nE AndroidRuntime: Process: com.android.commands.uiautomator, PID: 99\nE AndroidRuntime: java.lang.IllegalStateException';

interface Run { status: number | null; out: string; calls: string[]; state: string; out_dir: string }

function setup(): { state: string; bin: string; xml: string; out: string; apk: string } {
  const base = mkdtempSync(join(tmpdir(), 'android-scripts-test-'));
  dirs.push(base);
  const state = join(base, 'state');
  const bin = join(base, 'bin');
  const xml = join(base, 'xml');
  for (const d of [state, bin, xml]) mkdirSync(d);
  for (const name of ['adb', 'maestro', 'sleep']) {
    copyFileSync(join(STUBS, `${name}.sh`), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  copyFileSync(DIALOG, join(xml, 'dialog.xml'));
  writeFileSync(join(xml, 'app.xml'), APP_XML);
  writeFileSync(join(xml, 'blank.xml'), BLANK_XML);
  const apk = join(base, 'app.apk');
  writeFileSync(apk, 'apk');
  return { state, bin, xml, out: join(base, 'out'), apk };
}

function run(script: 'android-emulator-smoke.sh' | 'android-emulator-golden.sh', env: Record<string, string>): Run {
  const s = setup();
  const args = script === 'android-emulator-smoke.sh' ? [s.apk, s.out] : [s.apk, 'http://localhost:8791', s.out];
  const r = spawnSync('bash', [join(ROOT, 'scripts', script), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${s.bin}${delimiter}${process.env.PATH ?? ''}`, STATE: s.state.replace(/\\/g, '/'), XML_DIR: s.xml.replace(/\\/g, '/'), SMOKE_SETTLE_SECONDS: '0', ...env },
  });
  let calls: string[] = [];
  try { calls = readFileSync(join(s.state, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { /* no call was made */ }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, state: s.state, out_dir: s.out };
}
const taps = (calls: string[]): string[] => calls.filter((c) => c.startsWith('adb shell input tap'));
const dumps = (calls: string[]): number => calls.filter((c) => c.includes('uiautomator dump')).length;
const WAIT = 'adb shell input tap 540 1359'; // the middle of Wait in the real dialog tree

describe.skipIf(!bashAvailable)('android-emulator-smoke.sh, run whole against a stand-in adb', () => {
  const smoke = (env: Record<string, string>): Run => run('android-emulator-smoke.sh', env);

  it('app text on the first look: one look, no tap, success', () => {
    const r = smoke({ UI_SEQUENCE: 'app' });
    expect(r.status).toBe(0);
    expect(dumps(r.calls)).toBe(1);
    expect(taps(r.calls)).toEqual([]);
    expect(r.out).toContain('ok: the first screen is "Choose your server"');
  });

  it('a "not responding" dialog first: Wait is pressed once at the centre of the real button, and the next look finds the app', () => {
    const r = smoke({ UI_SEQUENCE: 'dialog,app' });
    expect(r.status).toBe(0);
    expect(taps(r.calls)).toEqual([WAIT]);
    expect(dumps(r.calls)).toBe(2);
    expect(r.out).toContain('UI tree read in 2 attempt(s)');
  });

  it('a dialog that comes back for the whole budget: after the last press there is one more look, so the checks read the screen and not the dialog', () => {
    const r = smoke({ UI_SEQUENCE: `${Array(LOOKS).fill('dialog').join(',')},app`, SMOKE_UI_ATTEMPTS: String(LOOKS) });
    expect(r.status).toBe(0);
    expect(taps(r.calls)).toHaveLength(LOOKS);
    expect(dumps(r.calls)).toBe(LOOKS + 1); // the looks in the loop, 1 after it
    expect(r.out).toContain('ok: the first screen is "Choose your server"');
  });

  it('control: the same dialog that is STILL there on the extra look is a failure with the honest message, not a pass', () => {
    const r = smoke({ UI_SEQUENCE: 'dialog', SMOKE_UI_ATTEMPTS: String(LOOKS) });
    expect(r.status).not.toBe(0);
    expect(dumps(r.calls)).toBe(LOOKS + 1);
    expect(r.out).toMatch(/does not belong to io\.inspectorhub\.app|not in the UI tree/);
  });

  it('a screen that never shows the first screen and no dialog: every look is used, no tap, a failure naming the attempts', () => {
    const r = smoke({ UI_SEQUENCE: 'blank', SMOKE_UI_ATTEMPTS: String(LOOKS) });
    expect(r.status).not.toBe(0);
    expect(dumps(r.calls)).toBe(LOOKS);
    expect(taps(r.calls)).toEqual([]);
    expect(r.out).toContain(`is not in the UI tree after ${String(LOOKS)} attempts`);
  });

  it('a FATAL EXCEPTION of the app fails the run; one of the test tooling does not', () => {
    const crashed = smoke({ UI_SEQUENCE: 'app', LOGCAT_TEXT: FATAL_APP });
    expect(crashed.status).not.toBe(0);
    expect(crashed.out).toContain('the app crashed');
    const tooling = smoke({ UI_SEQUENCE: 'app', LOGCAT_TEXT: FATAL_TOOLING });
    expect(tooling.status).toBe(0);
    expect(tooling.out).toContain('a FATAL EXCEPTION of another process is in logcat.txt');
  });
});

describe.skipIf(!bashAvailable)('android-emulator-golden.sh, run whole against a stand-in adb and maestro', () => {
  const golden = (env: Record<string, string>): Run => run('android-emulator-golden.sh', env);
  const at = (calls: string[], needle: string): number => calls.findIndex((c) => c.includes(needle));

  it('hides error dialogs before the app is started, looks once before Maestro starts, and makes no uiautomator call while it runs', () => {
    const r = golden({ UI_SEQUENCE: 'app' });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('OVERLAP'))).toBe(false);
    const hide = at(r.calls, 'settings put global hide_error_dialogs 1');
    const start = at(r.calls, 'am start -n io.inspectorhub.app/io.inspectorhub.app.MainActivity');
    const preflight = at(r.calls, 'uiautomator dump /sdcard/ui-preflight.xml');
    const maestro = at(r.calls, 'maestro start');
    const maestroEnd = at(r.calls, 'maestro end');
    expect(hide).toBeGreaterThan(-1);
    expect(hide).toBeLessThan(start);
    expect(start).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(maestro);
    // Nothing reads the screen between Maestro's start and its end.
    expect(r.calls.slice(maestro, maestroEnd + 1).some((c) => c.includes('uiautomator'))).toBe(false);
    expect(r.out).toContain('ok: G2 passed');
  });

  it('presses Wait on a dialog that is already on screen before Maestro starts, and not otherwise', () => {
    const withDialog = golden({ UI_SEQUENCE: 'dialog' });
    expect(withDialog.status).toBe(0);
    expect(taps(withDialog.calls)).toEqual([WAIT]);
    expect(at(withDialog.calls, WAIT)).toBeLessThan(at(withDialog.calls, 'maestro start'));
    expect(taps(golden({ UI_SEQUENCE: 'app' }).calls)).toEqual([]);
  });

  it('a failing Maestro fails the script and keeps the evidence (UI tree, logcat) instead of hiding it', () => {
    const r = golden({ UI_SEQUENCE: 'app', MAESTRO_EXIT: '1' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('android-emulator-golden failed');
    expect(r.calls.some((c) => c.includes('uiautomator dump /sdcard/ui-failure.xml'))).toBe(true);
    expect(r.out).not.toContain('ok: G2 passed');
  });

  it('a crash of the app during the flow fails the run even though Maestro passed; a tooling crash does not', () => {
    const crashed = golden({ UI_SEQUENCE: 'app', LOGCAT_TEXT: FATAL_APP });
    expect(crashed.status).not.toBe(0);
    expect(crashed.out).toContain('the app crashed during G2');
    expect(golden({ UI_SEQUENCE: 'app', LOGCAT_TEXT: FATAL_TOOLING }).status).toBe(0);
  });
});

describe.skipIf(!bashAvailable)('the stand-ins themselves (so a green run above means something)', () => {
  it('the adb stand-in refuses a uiautomator dump while the Maestro stand-in is running, and records it', () => {
    const s = setup();
    const env = { ...process.env, PATH: `${s.bin}${delimiter}${process.env.PATH ?? ''}`, STATE: s.state.replace(/\\/g, '/'), XML_DIR: s.xml.replace(/\\/g, '/'), UI_SEQUENCE: 'app' };
    writeFileSync(join(s.state, 'maestro.running'), '');
    const during = spawnSync('bash', ['-c', 'adb shell uiautomator dump /sdcard/x.xml'], { env, encoding: 'utf8' });
    expect(during.status).toBe(1);
    expect(readFileSync(join(s.state, 'calls.log'), 'utf8')).toContain('OVERLAP');
    rmSync(join(s.state, 'maestro.running'));
    expect(spawnSync('bash', ['-c', 'adb shell uiautomator dump /sdcard/x.xml'], { env, encoding: 'utf8' }).status).toBe(0);
  });
});
