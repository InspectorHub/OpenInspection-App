import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * The functions in ios-simulator.sh decide what happens on the macOS runner when the simulator is slow, silent or broken. They are run
 * here with a stubbed xcrun, so what is checked is the behaviour (which commands ran, in which order, what came back), not the text of
 * the script. The stubs say what the runner's logs showed: runs 41372183809, 41374220395 and 41375830738 (see the comments in the library).
 * What this cannot show is how a real simulator behaves; that is what the next CI run shows.
 */
// Each call to a stand-in is a process, and a hosted Windows runner starts them slowly: a generous limit for one test (the waits themselves are short).
vi.setConfig({ testTimeout: 120_000 });
const LIB = join(__dirname, 'ios-simulator.sh').replace(/\\/g, '/');
const DRIVER = join(__dirname, 'fixtures', 'ios-simulator-driver.sh').replace(/\\/g, '/');
const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0;
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const SPRINGBOARD_GAVE_UP = 'Monitoring boot status for iPhone 16e.\n[2026-11-02 01:40:13 +0000] Status=4294967295, isTerminal=YES, Elapsed=01:04.\n\tFinished';

interface Result { out: string; calls: string[]; status: number | null; seconds: number }

function run(scenario: string, env: Record<string, string> = {}): Result {
  const state = mkdtempSync(join(tmpdir(), 'ios-sim-test-'));
  dirs.push(state);
  const started = Date.now();
  const r = spawnSync('bash', [DRIVER], {
    encoding: 'utf8',
    timeout: 100_000, // vitest's timeout cannot interrupt a synchronous spawn; a hung script ends here and shows as a null status
    killSignal: 'SIGKILL',
    env: { ...process.env, LIB, STATE: state.replace(/\\/g, '/'), SCENARIO: scenario, SMOKE_ANSWER_QUICK: '3', SMOKE_ANSWER_LIMIT: '3', SMOKE_SPRINGBOARD_GRACE: '1', SMOKE_LAUNCH_LIMIT: '1', SMOKE_BOOT_LIMIT: '30', ...env },
  });
  const calls = readFileSync(join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  return { out: `${r.stdout}${r.stderr}`, calls, status: r.status, seconds: (Date.now() - started) / 1000 };
}
const resets = (calls: string[]): string[] => calls.filter((c) => /simctl shutdown all|simctl erase|^killall/.test(c));
const launches = (calls: string[]): number => calls.filter((c) => c.startsWith('script ')).length;

describe.skipIf(!bashAvailable)('boot_simulator', () => {
  const boot = 'if boot_simulator iphone UDID-1; then echo RESULT=booted; else echo RESULT=failed; fi';

  it('a normal boot: bootstatus ends well and SpringBoard is listed; nothing is reset and nothing says it gave up', () => {
    const r = run(boot);
    expect(r.out).toContain('RESULT=booted');
    expect(r.out).not.toContain('gave up');
    expect(resets(r.calls)).toEqual([]);
  });

  it('bootstatus gave up (Status=4294967295) but the simulator is up: it is left alone, nothing is shut down, erased or killed', () => {
    const r = run(boot, { BOOTSTATUS_TEXT: SPRINGBOARD_GAVE_UP });
    expect(r.out).toContain('RESULT=booted');
    expect(r.out).toContain('bootstatus gave up (attempt 1 of 3)');
    expect(resets(r.calls)).toEqual([]);
    expect(r.calls.filter((c) => c === 'xcrun simctl boot UDID-1')).toHaveLength(1);
  });

  it('bootstatus gave up and the simulator only answers after several probes: it WAITS for it (a first failed probe is not the end)', () => {
    // The limit is far away on purpose: a loaded machine (the whole suite runs in parallel) must not run out of it before the 7th probe.
    const r = run(boot, { BOOTSTATUS_TEXT: SPRINGBOARD_GAVE_UP, ANSWER_AFTER: '6', SMOKE_ANSWER_LIMIT: '60' });
    expect(r.out).toContain('RESULT=booted');
    expect(resets(r.calls)).toEqual([]);
    expect(r.calls.filter((c) => c.includes('launchctl list')).length).toBeGreaterThanOrEqual(7);
  });

  it('answering is not enough while SpringBoard is missing: it keeps waiting until the grace period ends, then goes on and prints what the simulator lists', () => {
    // A grace period of 2 whole seconds of the clock is 1 to 2 real seconds: plenty of probes whichever part of a second it starts in.
    const r = run(boot, { LIST: 'none', SMOKE_SPRINGBOARD_GRACE: '2', SMOKE_ANSWER_QUICK: '60' });
    expect(r.out).toContain('RESULT=booted');
    expect(r.out).toContain('no SpringBoard line with a pid showed up');
    expect(r.out).toContain('com.apple.something'); // the whole list, so the next log shows the real label
    expect(resets(r.calls)).toEqual([]);
  });

  it('answering is not enough: SpringBoard that shows up at the 5th probe is waited for, and the function returns on THAT probe, not on the first answer', () => {
    // Decided by the scenario, not by the clock: no machine speed can change how many probes there were.
    const r = run(boot, { LIST: 'none', SPRINGBOARD_AFTER: '4', SMOKE_SPRINGBOARD_GRACE: '60', SMOKE_ANSWER_QUICK: '120' });
    expect(r.out).toContain('RESULT=booted');
    expect(r.out).toContain('ok: iphone: SpringBoard is listed as: 123 0 com.apple.SpringBoard');
    expect(r.out).not.toContain('no SpringBoard line');
    expect(r.calls.filter((c) => c.includes('launchctl list'))).toHaveLength(5);
    expect(resets(r.calls)).toEqual([]);
  });

  it('control: with SpringBoard listed it returns on the first answer, without waiting for any grace period', () => {
    const r = run(boot);
    expect(r.out).toContain('RESULT=booted');
    expect(r.calls.filter((c) => c.includes('launchctl list'))).toHaveLength(1);
  });

  it('a simulator that never answers is reset between the attempts, never after the last one, and the failure says it is the simulator', () => {
    const r = run(boot, { BOOTSTATUS_TEXT: SPRINGBOARD_GAVE_UP, NEVER_ANSWER: '1', SMOKE_ANSWER_LIMIT: '1' });
    expect(r.out).toContain('RESULT=failed');
    expect(r.out).toContain('the simulator did not boot after 3 attempts; this is the runner\'s simulator, not the app');
    expect(r.calls.filter((c) => c === 'xcrun simctl boot UDID-1')).toHaveLength(3);
    // Two resets (after attempt 1 and 2), each of three commands; none after attempt 3.
    expect(r.calls.filter((c) => c === 'xcrun simctl shutdown all')).toHaveLength(2);
    expect(r.calls.filter((c) => c === 'xcrun simctl erase UDID-1')).toHaveLength(2);
    expect(r.calls.filter((c) => c.startsWith('killall'))).toHaveLength(2);
    expect(r.calls.at(-1)).not.toMatch(/shutdown|erase|killall/);
    // The reset comes after the wait for an answer, not instead of it.
    const firstReset = r.calls.findIndex((c) => /simctl shutdown all/.test(c));
    // At least one probe came first. How many fits in a one-second window depends on how fast this machine starts processes, so it is not counted.
    expect(r.calls.slice(0, firstReset).filter((c) => c.includes('launchctl list')).length).toBeGreaterThanOrEqual(1);
  });

  it('a launchctl probe that hangs is stopped at its limit, and the next probe is tried', () => {
    // The first probe would hang for 30 s; with a limit of 1 s it is stopped and the second one answers.
    const r = run(boot, { SPAWN_HANG_FIRST: '1', SMOKE_PROBE_LIMIT: '1', SMOKE_ANSWER_QUICK: '60' });
    expect(r.out).toContain('RESULT=booted');
    expect(r.calls.filter((c) => c.includes('launchctl list')).length).toBeGreaterThanOrEqual(2);
    expect(r.seconds).toBeLessThan(25); // it would be 30 s or more if the bound did nothing; the margin is for a loaded machine
  });

  it('a hung call that IGNORES SIGTERM is killed by timeout -k and is still read as "stopped by the limit" (status 137, not 124)', () => {
    // Without the 137 case the boot below would take the "bootstatus ended by itself" branch after 30 s instead of the give-up branch.
    const hungBoot = run(boot, { BOOTSTATUS_HANG: '20', SMOKE_BOOT_LIMIT: '1', IGNORE_TERM: '1' });
    expect(hungBoot.out).toContain('RESULT=booted');
    expect(hungBoot.out).toContain('was still running after 1 s and was stopped');
    expect(hungBoot.out).toContain('bootstatus gave up (attempt 1 of 3)');
    const hungProbe = run(boot, { SPAWN_HANG_FIRST: '1', SMOKE_PROBE_LIMIT: '1', SMOKE_ANSWER_QUICK: '60', IGNORE_TERM: '1' });
    expect(hungProbe.out).toContain('RESULT=booted');
    expect(hungProbe.out).toContain('a launchctl probe was still running after 1 s and was stopped');
  });

  it('a bootstatus that does not end by itself is stopped at its limit and treated as given up, not waited for forever', () => {
    const r = run(boot, { BOOTSTATUS_HANG: '20', SMOKE_BOOT_LIMIT: '1' });
    expect(r.out).toContain('RESULT=booted');
    expect(r.out).toContain('was still running after 1 s and was stopped');
    expect(r.out).toContain('bootstatus gave up (attempt 1 of 3)');
    expect(r.seconds).toBeLessThan(15); // it would take 20 s if the limit did nothing; the margin is for a loaded machine
    expect(resets(r.calls)).toEqual([]);
  });
});

describe.skipIf(!bashAvailable)('what the simulator listed is written down on every run', () => {
  const boot = 'if boot_simulator iphone UDID-1; then echo RESULT=booted; else echo RESULT=failed; fi';
  function summaryFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ios-sim-summary-'));
    dirs.push(dir);
    return join(dir, 'summary.md').replace(/\\/g, '/');
  }

  it('SpringBoard found: the line as the simulator printed it goes to the log and to the job summary, naming the simulator', () => {
    const summary = summaryFile();
    const r = run(boot, { GITHUB_STEP_SUMMARY: summary });
    expect(r.out).toContain('ok: iphone: SpringBoard is listed as: 123 0 com.apple.SpringBoard');
    expect(readFileSync(summary, 'utf8')).toContain('- iphone: SpringBoard listed as `123 0 com.apple.SpringBoard`');
  });

  it('SpringBoard not found within the grace period: the summary says so and lists what the simulator did list, so the real label can be read', () => {
    const summary = summaryFile();
    const r = run(boot, { LIST: 'none', GITHUB_STEP_SUMMARY: summary, SMOKE_SPRINGBOARD_GRACE: '2', SMOKE_ANSWER_QUICK: '60' });
    expect(r.out).toContain('RESULT=booted');
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('**SpringBoard was NOT listed**');
    expect(text).toContain('com.apple.something');
    expect(text).not.toContain('SpringBoard listed as');
  });

  it('without GITHUB_STEP_SUMMARY nothing is written anywhere and nothing fails (a run outside CI)', () => {
    const r = run(boot);
    expect(r.out).toContain('RESULT=booted');
    expect(r.out).toContain('SpringBoard is listed as');
  });
});

describe.skipIf(!bashAvailable)('app_is_running', () => {
  const check = 'if app_is_running UDID-1; then echo RUNNING; else echo NOT-RUNNING; fi';

  const started = 'echo 1 > "$STATE/launches"; '; // one launch has happened: the stand-in then lists the app

  it('is true for a pid, false for a dash, false when the app is not listed at all', () => {
    expect(run(check, { APP_UP_AT_LAUNCH: '1' }).out).toContain('NOT-RUNNING'); // no launch happened yet
    const running = run(started + check, { APP_UP_AT_LAUNCH: '1' }).out;
    expect(running).toContain('RUNNING');
    expect(running).not.toContain('NOT-RUNNING');
    expect(run(started + check, { APP_UP_AT_LAUNCH: '1', APP_DASH: '1' }).out).toContain('NOT-RUNNING');
  });

  it('is true when the app is listed twice, once with a dash and once with a pid (it can be, while it restarts)', () => {
    const out = run(started + check, { APP_UP_AT_LAUNCH: '1', APP_TWO_LINES: '1' }).out;
    expect(out).toContain('RUNNING');
    expect(out).not.toContain('NOT-RUNNING');
  });

  it('is false, not an error, when launchctl does not answer at all', () => {
    expect(run(started + check, { APP_UP_AT_LAUNCH: '1', NEVER_ANSWER: '1' }).out).toContain('NOT-RUNNING');
  });
});

describe.skipIf(!bashAvailable)('wait_for_app (a check that the app is STILL running)', () => {
  const started = 'echo 1 > "$STATE/launches"; ';
  const wait = (seconds: number): string => `if wait_for_app UDID-1 ${String(seconds)}; then echo RESULT=running; else echo RESULT=gone; fi`;

  it('is true at once when the app is listed', () => {
    const r = run(started + wait(5), { APP_UP_AT_LAUNCH: '1' });
    expect(r.out).toContain('RESULT=running');
    expect(r.calls.filter((c) => c.includes('launchctl list'))).toHaveLength(1);
  });

  it('a probe that hangs and is stopped is NOT "the app is gone": the next probe finds it (the shape of run 41397218349)', () => {
    // The first probe would hang for 30 s and is stopped after 1 s; the old check asked once and called that "not running".
    const r = run(started + wait(30), { APP_UP_AT_LAUNCH: '1', SPAWN_HANG_FIRST: '1', SMOKE_PROBE_LIMIT: '1' });
    expect(r.out).toContain('RESULT=running');
    expect(r.out).toContain('was still running after 1 s and was stopped (this says nothing about the app)');
    expect(r.calls.filter((c) => c.includes('launchctl list')).length).toBeGreaterThanOrEqual(2);
  });

  it('control: the single-probe check really does call that case "not running" (what the fix changes)', () => {
    const r = run(started + 'if app_is_running UDID-1; then echo RESULT=running; else echo RESULT=gone; fi', { APP_UP_AT_LAUNCH: '1', SPAWN_HANG_FIRST: '1', SMOKE_PROBE_LIMIT: '1' });
    expect(r.out).toContain('RESULT=gone');
  });

  it('an app that is really gone is still reported gone, once the time is up (a crash is not hidden by the retries)', () => {
    const r = run(wait(5), { APP_UP_AT_LAUNCH: '0' });
    expect(r.out).toContain('RESULT=gone');
    // It did not give up at the first probe: it asked again after the pause (a 5 s window leaves room for a second probe even when the first
    // one is slow), and it only said "gone" once the window was over.
    expect(r.calls.filter((c) => c.includes('launchctl list')).length).toBeGreaterThanOrEqual(2);
    expect(r.seconds).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(!bashAvailable)('launch_app', () => {
  const launch = 'if launch_app iphone UDID-1; then echo RETURNED; fi; if app_is_running UDID-1; then echo APP=running; else echo APP=not-running; fi';

  it('a launch that starts the app is not repeated', () => {
    const r = run(launch, { APP_UP_AT_LAUNCH: '1' });
    expect(r.out).toContain('APP=running');
    expect(launches(r.calls)).toBe(1);
    expect(r.calls.some((c) => c.includes('simctl terminate'))).toBe(false);
    expect(r.out).not.toContain('needed a second launch');
  });

  it('a launch that produced no process is stopped and repeated once; the second one is said out loud, in the log and in the job summary', () => {
    const summary = join(mkdtempSync(join(tmpdir(), 'ios-sim-summary-')), 'summary.md').replace(/\\/g, '/');
    dirs.push(join(summary, '..'));
    const r = run(launch, { APP_UP_AT_LAUNCH: '2', GITHUB_STEP_SUMMARY: summary });
    expect(r.out).toContain('APP=running');
    expect(launches(r.calls)).toBe(2);
    expect(r.out).toContain('the app needed a second launch to start');
    expect(readFileSync(summary, 'utf8')).toContain('needed a second launch');
    // The first launch is stopped BEFORE the second one starts.
    const scripts = r.calls.map((c, i) => [c, i] as const).filter(([c]) => c.startsWith('script '));
    const terminate = r.calls.findIndex((c) => c.includes('simctl terminate'));
    expect(terminate).toBeGreaterThan(scripts[0]![1]);
    expect(terminate).toBeLessThan(scripts[1]![1]);
    // And what the simulator was doing is printed.
    expect(r.out).toContain('what the simulator was doing');
  });

  it('a launch that never produces a process is tried twice and then handed back, so the caller\'s own check fails the run with the app\'s message', () => {
    const r = run(launch, { APP_UP_AT_LAUNCH: '0' });
    expect(launches(r.calls)).toBe(2);
    expect(r.out).toContain('RETURNED');
    expect(r.out).toContain('APP=not-running');
  });

  it('control: a launch that was listed with a dash (not running) counts as no process', () => {
    const r = run(launch, { APP_UP_AT_LAUNCH: '1', APP_DASH: '1' });
    expect(launches(r.calls)).toBe(2);
    expect(r.out).toContain('APP=not-running');
  });

  it('an app that crashed while it started is NOT launched again: the run fails saying so, so a crash cannot be retried into a green run', () => {
    const r = run(launch, { APP_UP_AT_LAUNCH: '0', CRASH_ON_LAUNCH: '1' });
    expect(launches(r.calls)).toBe(1);
    expect(r.out).toContain('FAIL: iphone: the app crashed on launch');
    expect(r.out).toContain('App-2026-11-02-crash.ips');
    expect(r.out).not.toContain('RETURNED');
  });

  it.each(['AppleSpell-2026-11-02-1.ips', 'AppStore-2026-11-02.ips', 'Application Stats.ips'])('a new report of another process (%s) is not the app\'s crash: the launch is repeated', (name) => {
    const r = run(launch, { APP_UP_AT_LAUNCH: '2', CRASH_ON_LAUNCH: '1', CRASH_NAME: name });
    expect(r.out).not.toContain('crashed on launch');
    expect(r.out).toContain('APP=running');
    expect(launches(r.calls)).toBe(2);
  });

  it.each(['App-2026-11-02-120000.ips', 'App_2026-11-02-120000.crash'])('a new report of the app itself (%s) stops the retry', (name) => {
    const r = run(launch, { APP_UP_AT_LAUNCH: '0', CRASH_ON_LAUNCH: '1', CRASH_NAME: name });
    expect(r.out).toContain('crashed on launch');
    expect(launches(r.calls)).toBe(1);
  });

  it('control: a crash report from BEFORE the launch (an old one in the folder) is not mistaken for this launch\'s crash', () => {
    const r = run(': > "$SMOKE_CRASH_DIR/App-2026-01-01-old.ips"; touch -d "-1 hour" "$SMOKE_CRASH_DIR/App-2026-01-01-old.ips"; ' + launch, { APP_UP_AT_LAUNCH: '2' });
    expect(r.out).toContain('APP=running');
    expect(r.out).not.toContain('crashed on launch');
    expect(launches(r.calls)).toBe(2);
  });
});
