import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * CI run 41367506059: the Android launch smoke failed because "Pixel Launcher isn't responding" (a system ANR dialog on the emulator)
 * sat in front of a healthy app, and the script read the same dialog tree 15 times. `dismiss_not_responding` taps its "Wait" button.
 * The fixture is the real uiautomator tree of that run; adb is stubbed, so this checks the parsing and the tap, not an emulator.
 */
const HELPER = join(__dirname, 'dismiss-not-responding.sh');
const FIXTURE = join(__dirname, 'fixtures', 'anr-pixel-launcher.ui.xml');
const bashAvailable = spawnSync('bash', ['-c', 'true']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'anr-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(xmlPath: string): { code: number; adbCalls: string[]; out: string } {
  const log = join(dir, `adb-${Math.random().toString(36).slice(2)}.log`);
  writeFileSync(log, '');
  const script = `set -Eeuo pipefail
adb() { echo "adb $*" >> "${log.replace(/\\/g, '/')}"; }
. "${HELPER.replace(/\\/g, '/')}"
if dismiss_not_responding "${xmlPath.replace(/\\/g, '/')}"; then echo "RC=0"; else echo "RC=1"; fi`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const rc = /RC=(\d)/.exec(r.stdout)?.[1];
  return { code: rc === undefined ? 99 : Number(rc), adbCalls: readFileSync(log, 'utf8').split('\n').filter(Boolean), out: r.stdout + r.stderr };
}

describe.skipIf(!bashAvailable)('dismiss_not_responding', () => {
  it('taps the middle of "Wait" on the real "Pixel Launcher isn\'t responding" tree', () => {
    const r = run(FIXTURE);
    expect(r.code).toBe(0);
    // Wait is bounds [70,1296][1010,1422]: the middle is (540, 1359).
    expect(r.adbCalls).toEqual(['adb shell input tap 540 1359']);
    expect(r.out).toContain('::warning::');
  });

  it('does nothing, and says it did nothing, on a tree without that dialog (control: the screen of the app)', () => {
    const xml = join(dir, 'app.ui.xml');
    writeFileSync(xml, '<?xml version="1.0"?><hierarchy rotation="0"><node index="0" text="Choose your server" resource-id="" class="android.widget.TextView" package="io.inspectorhub.app" bounds="[0,0][1080,200]" /></hierarchy>');
    const r = run(xml);
    expect(r.code).toBe(1);
    expect(r.adbCalls).toEqual([]);
  });

  it('does not tap "Close app": only the Wait button is ever pressed', () => {
    const xml = readFileSync(FIXTURE, 'utf8');
    expect(xml).toContain('aerr_wait');
    const r = run(FIXTURE);
    expect(r.adbCalls.join('\n')).not.toMatch(/tap 540 12[0-9]{2}\b/); // the Close app row is centred near y=1233
  });

  it('a tree with a Wait-looking label but another resource id is left alone', () => {
    const xml = join(dir, 'lookalike.ui.xml');
    writeFileSync(xml, '<?xml version="1.0"?><hierarchy><node index="0" text="Wait" resource-id="com.example:id/wait" class="android.widget.Button" package="com.example" bounds="[0,0][100,100]" /></hierarchy>');
    const r = run(xml);
    expect(r.code).toBe(1);
    expect(r.adbCalls).toEqual([]);
  });

  it('a missing file is treated as "no dialog", not as an error that stops the script', () => {
    const r = run(join(dir, 'does-not-exist.xml'));
    expect(r.code).toBe(1);
    expect(r.adbCalls).toEqual([]);
  });
});
