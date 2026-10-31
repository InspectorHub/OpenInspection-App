import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DesktopBridge, DecodeHeicReply } from '../electron/shared/ipc-contract.ts';

function runHelper(executable: string, args: string[], input: Buffer): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', rejectRun);
    child.once('close', (code) => resolveRun({ code, stdout: Buffer.concat(chunks) }));
    child.stdin.end(input);
  });
}
let electronApp: ElectronApplication;
let page: Page;
let userData: string;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-heic-ci-'));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.OI_USER_DATA_DIR = userData;
  env.OI_RENDERER_ROOT = 'e2e-electron/fixtures/shell-page';
  env.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  env.OI_E2E_HEIC_HELPER = resolve('dist-electron/native/win-heic-helper.exe');
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env });
  page = await electronApp.firstWindow();
  await expect(page.locator('#status')).toHaveText('Shell checks complete');
});

test.afterEach(async () => {
  await electronApp?.close();
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('CI helper executable starts and rejects invalid protocol input without requiring a codec', async () => {
  const helper = resolve('dist-electron/native/win-heic-helper.exe');
  const invalidImage = await runHelper(helper, ['--max-long-edge', '32'], Buffer.from('not a HEIF image'));
  expect(invalidImage).toEqual({ code: 3, stdout: Buffer.alloc(0) });
  const invalidSwitch = await runHelper(helper, ['--max-long-edge', '0'], Buffer.alloc(0));
  expect(invalidSwitch).toEqual({ code: 3, stdout: Buffer.alloc(0) });
});

test('real Electron IPC passes non-HEIF bytes to the helper and returns the closed unsupported code', async () => {
  const reply = await page.evaluate(async () => {
    const bridge = (window as unknown as { oiDesktop: DesktopBridge }).oiDesktop;
    return bridge.media.decodeHeic({ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer, maxLongEdge: 32 });
  });
  expect(reply satisfies DecodeHeicReply).toEqual({ ok: false, code: 'UNSUPPORTED' });
});

test('main process rejects malformed request bounds before helper execution', async () => {
  await expect(page.evaluate(async () => {
    const bridge = (window as unknown as { oiDesktop: DesktopBridge }).oiDesktop;
    return bridge.media.decodeHeic({ bytes: Uint8Array.of(1).buffer, maxLongEdge: 1.5 });
  })).rejects.toThrow(/invalid-argument/);
});
