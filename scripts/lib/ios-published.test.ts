import { type ChildProcess, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

/**
 * scripts/ios-simulator-published.sh drives golden flow G5 on the iOS simulator. It is run here with a stand-in xcrun and maestro and a
 * small stand-in for the fake engine's control server, so what is checked is the ORDER of the calls and what the script does when the
 * engine disagrees with the screen. What this cannot show: that a real simulator trusts the certificate, that Maestro finds the texts on
 * iOS, or that the app signs in over https. The first CI run of the ios-simulator-published job shows that.
 */
vi.setConfig({ testTimeout: 120_000 });
const SCRIPT = join(__dirname, '..', 'ios-simulator-published.sh').replace(/\\/g, '/');
const SIGN_IN_FLOW = join(__dirname, '..', '..', 'maestro', 'ios', 'sign-in.yaml');
const REPUBLISH_FLOW = join(__dirname, '..', '..', 'maestro', 'ios', 'g5-b-republish-with-notice.yaml');
const bashAvailable = (() => { try { return spawn('bash', ['-c', 'true']).pid !== undefined; } catch { return false; } })();
const dirs: string[] = [];
const servers: Server[] = [];
afterAll(() => { for (const s of servers) s.close(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// A stand-in xcrun: it records every call and answers what the script's waits need (SpringBoard and the app listed with a pid).
const XCRUN = `#!/usr/bin/env bash
echo "xcrun $*" >> "$STATE/calls.log"
[ "\${1:-}" = simctl ] || exit 0
case "\${2:-}" in
  bootstatus) echo "Device already booted, nothing to do." ;;
  spawn)
    case "$*" in
      *"launchctl list"*) printf '123\\t0\\tcom.apple.SpringBoard\\n4242\\t0\\tUIKitApplication:io.inspectorhub.app[abcd]\\n' ;;
    esac ;;
  io) touch "\${5:-/dev/null}" ;;
esac
exit 0
`;
// A stand-in script(1), which the app is launched under (a bare `simctl launch` needs a terminal that CI does not have): it records what it was
// asked to run, which is all the stand-in xcrun needs, since the app's process is reported by its `launchctl list` answer.
const SCRIPT_STANDIN = `#!/usr/bin/env bash
echo "script $*" >> "$STATE/calls.log"
exit 0
`;
// A stand-in maestro: it records its arguments and fails when asked to (MAESTRO_FAIL_ON: a part of the command line, such as a flow file name).
const MAESTRO = `#!/usr/bin/env bash
echo "maestro $*" >> "$STATE/calls.log"
args="$*"
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then shift; output="$1"; fi
  shift || true
done
if [[ "$args" == *"\${MAESTRO_TRANSPORT_FAIL_ON:-@@never@@}"* ]] && [ ! -e "$STATE/transport-failed" ]; then
  touch "$STATE/transport-failed"
  [ "\${MAESTRO_TRANSPORT_STATE_DRIFT:-}" != "1" ] || touch "$STATE/transport-state-drift"
  printf '%s\\n' '<testsuites><testsuite><testcase><failure>maestro.DeviceUnreachableException: Transport unreachable while processing deviceInfo</failure></testcase></testsuite></testsuites>' > "$output"
  exit 1
fi
case "$args" in
  *"\${MAESTRO_FAIL_ON:-@@never@@}"*)
    echo "flow failed on screen"
    printf '%s\\n' '<testsuites><testsuite><testcase><failure>flow failed on screen</failure></testcase></testsuite></testsuites>' > "$output"
    exit 1
    ;;
esac
echo x >> "$STATE/maestro-runs"
exit 0
`;

interface Result { out: string; calls: string[]; status: number | null }

/** The control server's answer depends on how many times maestro ran: before any run, after part A, after part B. */
async function controlServer(state: string, answers: unknown[]): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== '/__test__/state') { response.writeHead(404).end(); return; }
    if (existsSync(join(state, 'transport-state-drift'))) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        report: { state: 'locked', version: 4 }, publishes: [UNCHANGED], errors: [],
      }));
      return;
    }
    const runsFile = join(state, 'maestro-runs');
    const runs = existsSync(runsFile) ? readFileSync(runsFile, 'utf8').split('\n').filter(Boolean).length : 0;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answers[Math.min(runs, answers.length - 1)]));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`;
}

const report = (state: string, version: number, publishes: unknown[]) => ({ report: { state, version }, publishes, errors: [] });
const UNCHANGED = { notifyClient: null, summary: null, outcome: 'unchanged' };
const NEW_VERSION = { notifyClient: true, summary: 'Corrected the roof rating', outcome: 'new_version' };
const START = report('locked', 3, []);
const AFTER_A = report('locked', 3, [UNCHANGED]);
const AFTER_B = report('locked', 4, [UNCHANGED, NEW_VERSION]);
const HAPPY = [START, AFTER_A, AFTER_B];

async function run(answers: unknown[], options: { env?: Record<string, string>; origin?: string; noCert?: boolean } = {}): Promise<Result> {
  const state = mkdtempSync(join(tmpdir(), 'ios-published-test-'));
  dirs.push(state);
  const posix = (p: string): string => p.replace(/\\/g, '/');
  const bin = join(state, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'xcrun'), XCRUN, { mode: 0o755 });
  writeFileSync(join(bin, 'maestro'), MAESTRO, { mode: 0o755 });
  writeFileSync(join(bin, 'script'), SCRIPT_STANDIN, { mode: 0o755 });
  chmodSync(join(bin, 'script'), 0o755);
  chmodSync(join(bin, 'xcrun'), 0o755);
  chmodSync(join(bin, 'maestro'), 0o755);
  mkdirSync(join(state, 'App.app'));
  mkdirSync(join(state, 'crash'));
  writeFileSync(join(state, 'cert.pem'), 'not a real certificate');
  const control = await controlServer(state, answers);
  const certArg = posix(options.noCert ? join(state, 'missing.pem') : join(state, 'cert.pem'));
  const child: ChildProcess = spawn('bash', [SCRIPT, posix(join(state, 'App.app')), options.origin ?? 'https://localhost:9443', control, certArg, posix(join(state, 'out'))], {
    env: {
      ...process.env, PATH: `${posix(bin)}:${process.env.PATH ?? ''}`, STATE: posix(state), SIM_UDID: 'UDID-1', SMOKE_CRASH_DIR: posix(join(state, 'crash')),
      SMOKE_SETTLE_SECONDS: '0', SMOKE_ANSWER_QUICK: '5', SMOKE_BOOT_LIMIT: '30', SMOKE_POLL_SECONDS: '0', ...options.env,
    },
  });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  const callsFile = join(state, 'calls.log');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : [];
  return { out, calls, status };
}
const maestroCalls = (calls: string[]): string[] => calls.filter((c) => c.startsWith('maestro '));
const indexOf = (calls: string[], needle: string): number => calls.findIndex((c) => c.includes(needle));

describe.skipIf(!bashAvailable)('ios-simulator-published.sh', () => {
  it('waits for the signed-in work-list action rather than its heading before continuing', () => {
    const flow = readFileSync(SIGN_IN_FLOW, 'utf8');
    const fieldReady = flow.indexOf('visible: "https://app.inspectorhub.io"');
    const fieldTap = flow.indexOf('point: "57%,24%"');
    const erase = flow.indexOf('- eraseText: 80', fieldTap);
    const fieldInput = flow.indexOf('- inputText: "${SERVER_URL}"');
    expect(fieldReady).toBeGreaterThan(0);
    expect(fieldTap).toBeGreaterThan(fieldReady);
    expect(erase).toBeGreaterThan(fieldTap);
    expect(fieldInput).toBeGreaterThan(erase);
    expect(flow).toContain('visible: "Download today\'s work"');
    expect(flow).not.toContain('visible: "Work list"');
    expect(flow).toContain('- assertVisible: "Online"');
    expect(flow).not.toContain('point: "95%,23%"');
  });

  it('retries the iOS compatibility connection once only when sign-in does not appear', () => {
    const flow = readFileSync(SIGN_IN_FLOW, 'utf8');
    const connectPrompt = flow.indexOf('assertVisible: "Connect to this server?"');
    const retry = flow.indexOf('maxRetries: 1', connectPrompt);
    const connect = flow.indexOf('- tapOn: "Connect"', retry);
    const signInWait = flow.indexOf('visible: "Sign in"', connect);
    const signInTap = flow.indexOf('text: "Sign in"', signInWait);
    expect(connectPrompt).toBeGreaterThan(0);
    expect(retry).toBeGreaterThan(connectPrompt);
    expect(connect).toBeGreaterThan(retry);
    expect(signInWait).toBeGreaterThan(connect);
    expect(signInTap).toBeGreaterThan(signInWait);
    expect(flow.slice(retry, signInTap)).toContain('timeout: 20000');
  });

  it('scrolls the iOS republish modal again after the checkbox dismisses the keyboard', () => {
    const flow = readFileSync(REPUBLISH_FLOW, 'utf8');
    const checkbox = flow.indexOf('- tapOn: "Send the report-updated notices"');
    const secondScroll = flow.indexOf('- swipe:', checkbox);
    const publishReady = flow.indexOf('visible: "Just publish"', secondScroll);
    const publish = flow.indexOf('- tapOn: "Just publish"', publishReady);
    expect(checkbox).toBeGreaterThan(0);
    expect(secondScroll).toBeGreaterThan(checkbox);
    expect(publishReady).toBeGreaterThan(secondScroll);
    expect(publish).toBeGreaterThan(publishReady);
  });

  it('a full run: trusts the certificate before the app is installed, runs part A then part B on the pinned device, and checks the engine after each', async () => {
    const r = await run(HAPPY);
    expect(r.out).toContain('ios-simulator-published: G5 passed');
    expect(r.status).toBe(0);
    expect(indexOf(r.calls, 'simctl keychain UDID-1 add-root-cert')).toBeGreaterThanOrEqual(0);
    expect(indexOf(r.calls, 'simctl keychain')).toBeLessThan(indexOf(r.calls, 'simctl install'));
    // The app is launched under script(1) (the smoke job's way): after the install, with the pinned device.
    expect(indexOf(r.calls, 'simctl install')).toBeLessThan(indexOf(r.calls, 'script -q -F'));
    expect(r.calls.some((c) => c.startsWith('script ') && c.includes('simctl launch --console-pty UDID-1 io.inspectorhub.app'))).toBe(true);
    const [a, b, ...more] = maestroCalls(r.calls);
    expect(more).toEqual([]);
    expect(a).toContain('--platform ios --device UDID-1 test -e SERVER_URL=https://localhost:9443');
    expect(a).toContain('g5-a-published-report.yaml');
    expect(b).toContain('--device UDID-1');
    expect(b).toContain('g5-b-republish-with-notice.yaml');
    expect(b).not.toContain('SERVER_URL');
    expect(r.out).toContain('the engine holds version 4, locked');
  });

  it('retries once after XCUITest transport loss only when the engine still has the expected state', async () => {
    const r = await run(HAPPY, { env: { MAESTRO_TRANSPORT_FAIL_ON: 'g5-a' } });
    expect(r.status).toBe(0);
    expect(r.out).toContain('verifying the engine is unchanged before one retry');
    expect(r.out).toContain('ios-simulator-published: G5 passed');
    const calls = maestroCalls(r.calls);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('g5-a-published-report.yaml');
    expect(calls[1]).toContain('g5-a-published-report.yaml');
    expect(calls[2]).toContain('g5-b-republish-with-notice.yaml');
    expect(calls[0]).toContain('SERVER_URL=https://localhost:9443');
    expect(calls[1]).toContain('SERVER_URL=https://localhost:9443');
    expect(calls[2]).toContain('SUMMARY=Corrected the roof rating');
    const retryLaunch = r.calls.findIndex((call) => call.includes('g5-a-retry.typescript'));
    expect(retryLaunch).toBeGreaterThan(r.calls.findIndex((call) => call.includes('simctl terminate UDID-1 io.inspectorhub.app')));
    const retryFlow = r.calls.findIndex((call, index) => index > retryLaunch && call.startsWith('maestro ') && call.includes('g5-a-published-report.yaml'));
    expect(retryFlow).toBeGreaterThan(retryLaunch);
  });

  it('does not retry after XCUITest transport loss if the engine state changed', async () => {
    const r = await run(HAPPY, { env: { MAESTRO_TRANSPORT_FAIL_ON: 'g5-a', MAESTRO_TRANSPORT_STATE_DRIFT: '1' } });
    expect(r.status).not.toBe(0);
    expect(maestroCalls(r.calls)).toHaveLength(1);
    expect(r.calls.some((call) => call.includes('g5-a-retry.typescript'))).toBe(false);
    expect(r.out).toContain('expected');
  });

  it('refuses a plain-http engine address before touching the simulator (the app has no ATS exception)', async () => {
    const r = await run(HAPPY, { origin: 'http://localhost:8791' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('must be https');
    expect(r.calls).toEqual([]);
  });

  it('refuses a missing certificate before touching the simulator', async () => {
    const r = await run(HAPPY, { noCert: true });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('no certificate');
    expect(r.calls).toEqual([]);
  });

  it('an engine that is not at the start state stops the run before any flow (a repeated run would otherwise prove nothing)', async () => {
    const r = await run([report('locked', 4, [UNCHANGED])]);
    expect(r.status).not.toBe(0);
    expect(maestroCalls(r.calls)).toEqual([]);
  });

  it('part A passes on screen but the engine saw no publish: the run fails and part B never starts', async () => {
    const r = await run([START]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('expected');
    expect(maestroCalls(r.calls)).toHaveLength(1);
  });

  it('part A fails on screen: the engine is not asked, part B never starts, and the evidence is saved', async () => {
    const r = await run(HAPPY, { env: { MAESTRO_FAIL_ON: 'g5-a' } });
    expect(r.status).not.toBe(0);
    expect(maestroCalls(r.calls)).toHaveLength(1);
    expect(r.out).toContain('ios-simulator-published failed');
    expect(r.calls.some((c) => c.includes('simctl io UDID-1 screenshot') && c.includes('screen-at-failure.png'))).toBe(true);
  });

  it('part B passes on screen but the engine still holds version 3: the run fails', async () => {
    const r = await run([START, AFTER_A, report('locked', 3, [UNCHANGED])]);
    expect(r.status).not.toBe(0);
    expect(maestroCalls(r.calls)).toHaveLength(2);
    expect(r.out).not.toContain('G5 passed');
  });
});
