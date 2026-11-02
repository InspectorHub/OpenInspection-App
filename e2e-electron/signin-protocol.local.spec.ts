import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
let electronApp: ElectronApplication | undefined;
let userData: string;
let environment: Record<string, string>;
const environmentNames = ['OI_USER_DATA_DIR', 'OI_RENDERER_ROOT', 'OI_E2E_DISABLE_PROTOCOL_REGISTRATION'] as const;
let previousEnvironment: Partial<Record<(typeof environmentNames)[number], string>>;

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-protocol-local-'));
  previousEnvironment = Object.fromEntries(environmentNames.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name] as string]]));
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.OI_E2E_DISABLE_PROTOCOL_REGISTRATION;
  environment.OI_USER_DATA_DIR = userData;
  environment.OI_RENDERER_ROOT = 'e2e-electron/fixtures/shell-page';
  process.env.OI_USER_DATA_DIR = userData;
  process.env.OI_RENDERER_ROOT = environment.OI_RENDERER_ROOT;
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env: environment });
});

test.afterEach(async () => {
  try {
    await electronApp?.close();
    if (process.platform === 'win32') {
      const registration = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Classes\\io.inspectorhub.app'], { encoding: 'utf8', windowsHide: true });
      expect(registration.status).toBe(1);
      expect(`${registration.stdout}${registration.stderr}`).toMatch(/unable to find|cannot find/i);
    }
  } finally {
    await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    for (const name of environmentNames) {
      if (previousEnvironment[name] === undefined) delete process.env[name];
      else process.env[name] = previousEnvironment[name];
    }
  }
});

test('registered development protocol dispatches through PowerShell into the running app', async () => {
  if (process.platform !== 'win32') throw new Error('local-protocol-test-requires-windows');
  if (!electronApp) throw new Error('electron-app-not-started');
  const page = await electronApp.firstWindow();
  await expect(page.locator('#status')).toHaveText('Shell checks complete');
  const registration = await execFileAsync('reg.exe', ['query', 'HKCU\\Software\\Classes\\io.inspectorhub.app\\shell\\open\\command', '/ve'], { windowsHide: true });
  expect(registration.stdout).toContain('dist-electron\\main\\index.cjs');
  const callback = 'io.inspectorhub.app:/oauth/callback?code=local-protocol&state=ready';
  const powershellCommand = `Start-Process -FilePath '${callback}'`;
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', powershellCommand], { windowsHide: true });
  await expect(page.locator('#callback')).toHaveText(callback);
});
