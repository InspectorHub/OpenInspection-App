import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The Android emulator scripts are run WHOLE, with a stand-in adb, maestro and sleep first on PATH (source in fixtures/android-stubs),
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

  it.each(['abc', '0', '-3', '1.5', '2x'])('SMOKE_UI_ATTEMPTS=%s is refused at once (a word would make `[ -ge ]` fail for ever and the loop never end)', (value) => {
    const r = smoke({ UI_SEQUENCE: 'blank', SMOKE_UI_ATTEMPTS: value });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('SMOKE_UI_ATTEMPTS must be a whole number of at least 1');
    expect(dumps(r.calls)).toBe(0); // it never got as far as looking at the screen
  });

  it('an empty SMOKE_UI_ATTEMPTS means the default (15), not an error', () => {
    const r = smoke({ UI_SEQUENCE: 'app', SMOKE_UI_ATTEMPTS: '' });
    expect(r.status).toBe(0);
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

  it('waits for the first screen before Maestro starts; the stand-in would refuse a screen read while Maestro runs (a later edit that put Maestro in the background would be caught)', () => {
    const r = golden({ UI_SEQUENCE: 'app' });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('OVERLAP'))).toBe(false);
    const hide = at(r.calls, 'settings put global hide_error_dialogs 1');
    const clear = at(r.calls, 'pm clear io.inspectorhub.app');
    const start = at(r.calls, 'am start -n io.inspectorhub.app/io.inspectorhub.app.MainActivity');
    const preflight = at(r.calls, 'uiautomator dump /sdcard/ui-preflight.xml');
    const maestro = at(r.calls, 'maestro start');
    const maestroEnd = at(r.calls, 'maestro end');
    expect(hide).toBeGreaterThan(-1);
    expect(hide).toBeLessThan(start);
    expect(clear).toBeLessThan(start);
    expect(start).toBeLessThan(at(r.calls, 'uiautomator dump /sdcard/ui-wait.xml'));
    expect(at(r.calls, 'uiautomator dump /sdcard/ui-wait.xml')).toBeLessThan(preflight);
    expect(preflight).toBeLessThan(maestro);
    // Maestro runs in the foreground here, so nothing can read the screen between its start and its end; this keeps it that way.
    expect(r.calls.slice(maestro, maestroEnd + 1).some((c) => c.includes('uiautomator'))).toBe(false);
    expect(r.out).toContain('ok: G2 passed');
  });

  it('restarts after pm clear races with task removal and the app never draws its first screen', () => {
    const r = golden({ UI_SEQUENCE: 'blank,app,app', START_SCREEN_SECONDS: '0' });
    expect(r.status).toBe(0);
    expect(r.calls.filter((c) => c.startsWith('adb shell am start -n'))).toHaveLength(2);
    expect(r.calls.filter((c) => c.startsWith('adb shell am force-stop io.inspectorhub.app'))).toHaveLength(1);
    expect(readFileSync(join(r.out_dir, 'first-screen-attempt-1.png'), 'utf8')).toBe('PNGDATA');
    expect(r.out).toContain('the app needed 2 launches');
    expect(r.out).toContain('ok: G2 passed');
  });

  it('presses Wait on a dialog that is already on screen before Maestro starts, and not otherwise', () => {
    const withDialog = golden({ UI_SEQUENCE: 'dialog,app', START_SCREEN_SECONDS: '0' });
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

describe.skipIf(!bashAvailable)('android-emulator-published.sh (G5), run whole against a stand-in adb, maestro and engine control server', () => {
  // The stand-in engine control server answers GET /__test__/state from where the run is: how many times the stand-in maestro has started
  // (read from the calls log the stand-ins write) says which part of the flow has passed. 0 = before part A, 1 = after A, 2 = after B.
  const REPORT_AFTER_A = [{ notifyClient: null, summary: null, outcome: 'unchanged' }];
  const REPORT_AFTER_B = [...REPORT_AFTER_A, { notifyClient: true, summary: 'Corrected the roof rating', outcome: 'new_version' }];
  const GOOD = [
    { report: { state: 'locked', version: 3 }, publishes: [], errors: [] },
    { report: { state: 'locked', version: 3 }, publishes: REPORT_AFTER_A, errors: [] },
    { report: { state: 'locked', version: 4 }, publishes: REPORT_AFTER_B, errors: [] },
  ];

  async function published(options: { stages?: unknown[]; env?: Record<string, string> }): Promise<Run> {
    const s = setup();
    const stages = options.stages ?? GOOD;
    const server: Server = createServer((_request, response) => {
      let started = 0;
      try { started = readFileSync(join(s.state, 'calls.log'), 'utf8').split('\n').filter((c) => c.startsWith('maestro start')).length; } catch { /* nothing has run yet */ }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stages[Math.min(started, stages.length - 1)]));
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    const control = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
    try {
      const env = { ...process.env, PATH: `${s.bin}${delimiter}${process.env.PATH ?? ''}`, STATE: s.state.replace(/\\/g, '/'), XML_DIR: s.xml.replace(/\\/g, '/'), SMOKE_SETTLE_SECONDS: '0', UI_SEQUENCE: 'app', ...options.env };
      const child = spawn('bash', [join(ROOT, 'scripts', 'android-emulator-published.sh'), s.apk, 'http://localhost:8793', control, s.out], { cwd: ROOT, env });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { out += chunk.toString(); });
      const status = await new Promise<number | null>((resolveClose) => child.on('close', resolveClose));
      let calls: string[] = [];
      try { calls = readFileSync(join(s.state, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { /* no call was made */ }
      return { status, out, calls, state: s.state, out_dir: s.out };
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  }
  const maestroRuns = (calls: string[]): string[] => calls.filter((c) => c.startsWith('maestro start'));

  it('control: against an engine that tells the true story it passes, running part A then part B in order, with the engine checked before, between and after', async () => {
    const r = await published({});
    expect(r.out).toContain('android-emulator-published: G5 passed');
    expect(r.status).toBe(0);
    const runs = maestroRuns(r.calls);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain('g5-a-published-report.yaml');
    expect(runs[0]).toContain('SERVER_URL=http://localhost:8793');
    expect(runs[1]).toContain('g5-b-republish-with-notice.yaml');
    expect(r.out).toContain('ok: the report is locked at version 3');
    expect(r.out).toContain('ok: the report is locked at version 4');
    expect(r.out).toContain('ok: no crash in logcat');
    // The app's data is cleared once, before part A, and the engine port is forwarded to the device.
    expect(r.calls.filter((c) => c.includes('pm clear'))).toHaveLength(1);
    expect(r.calls).toContain('adb reverse tcp:8793 tcp:8793');
    expect(r.calls.findIndex((c) => c.includes('pm clear'))).toBeLessThan(r.calls.findIndex((c) => c.startsWith('maestro start')));
  });

  it('fails at once when the engine does not start as a report locked at version 3, and starts no flow (a repeated run would otherwise start from the end of the last)', async () => {
    const r = await published({ stages: [{ report: { state: 'locked', version: 4 }, publishes: [], errors: [] }] });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('the report is at version 4, expected 3');
    expect(maestroRuns(r.calls)).toHaveLength(0);
    expect(r.out).not.toContain('G5 passed');
    // The same engine, not locked, is refused too.
    const editing = await published({ stages: [{ report: { state: 'editing', version: 3 }, publishes: [], errors: [] }] });
    expect(editing.status).not.toBe(0);
    expect(editing.out).toContain('the report is editing, expected locked');
    expect(maestroRuns(editing.calls)).toHaveLength(0);
  }, 120_000);

  it('fails when the engine saw other publishes than the screen promised after part A, and does not run part B', async () => {
    // The screen would say "Nothing to publish" while the engine was in fact sent a notice choice.
    const wrong = [{ notifyClient: true, summary: null, outcome: 'unchanged' }];
    const r = await published({ stages: [GOOD[0], { report: { state: 'locked', version: 3 }, publishes: wrong, errors: [] }, GOOD[2]] });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('the publishes the engine saw are');
    expect(maestroRuns(r.calls)).toHaveLength(1);
    expect(r.out).not.toContain('G5 part B passed');
    expect(r.out).not.toContain('G5 passed');
  }, 120_000);

  it('a failing Maestro in part A fails the script, keeps the evidence, and never starts part B', async () => {
    const r = await published({ env: { MAESTRO_EXIT: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('android-emulator-published failed');
    expect(r.calls.some((c) => c.includes('uiautomator dump /sdcard/ui-failure.xml'))).toBe(true);
    expect(maestroRuns(r.calls)).toHaveLength(1);
    expect(r.out).not.toContain('G5 part A passed');
    expect(r.out).not.toContain('G5 passed');
  });

  it('a crash of the app in logcat fails the run even though both parts and the engine agree; a crash of the test tooling does not', async () => {
    const crashed = await published({ env: { LOGCAT_TEXT: FATAL_APP } });
    expect(crashed.status).not.toBe(0);
    expect(crashed.out).toContain('the app crashed during G5');
    expect(maestroRuns(crashed.calls)).toHaveLength(2);
    expect(crashed.out).not.toContain('G5 passed');
    const tooling = await published({ env: { LOGCAT_TEXT: FATAL_TOOLING } });
    expect(tooling.status).toBe(0);
    expect(tooling.out).toContain('G5 passed');
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
