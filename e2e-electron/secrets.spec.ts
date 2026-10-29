import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let electronApp: ElectronApplication;
let page: Page;
let userData: string;

function aclRules(path: string): Array<{ sid: string; access: string; rights: number }> {
  const escapedPath = path.replaceAll("'", "''");
  const script = `$path = '${escapedPath}'; $acl = if ([System.IO.Directory]::Exists($path)) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }; $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { Write-Output ($_.IdentityReference.Value + '|' + $_.AccessControlType + '|' + [int64]$_.FileSystemRights) }`;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sid, access, rights] = line.split('|');
      return { sid: sid!, access: access!, rights: Number(rights) };
    });
}

function hasRights(rule: { rights: number }, mask: number): boolean {
  return (rule.rights & mask) === mask;
}

test.beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'oi-secrets-e2e-'));
  const secretsDir = join(userData, 'secrets');
  await mkdir(secretsDir);
  await writeFile(join(secretsDir, 'acl-probe.txt'), 'pre-existing data remains readable');
  await writeFile(join(secretsDir, 'root.secret'), Buffer.from('root pre-existing ciphertext'));
  const nestedDir = join(secretsDir, 'nested');
  await mkdir(nestedDir);
  await writeFile(join(nestedDir, 'nested-probe.txt'), 'nested pre-existing data remains readable');
  await writeFile(join(nestedDir, 'first.secret'), Buffer.from('nested-first-ciphertext'));
  await writeFile(join(nestedDir, 'second.secret'), Buffer.from('nested-second-ciphertext'));
  const seededPaths = [secretsDir, join(secretsDir, 'acl-probe.txt'), join(secretsDir, 'root.secret'), nestedDir, join(nestedDir, 'nested-probe.txt'), join(nestedDir, 'first.secret'), join(nestedDir, 'second.secret')];
  for (const path of seededPaths) {
    execFileSync('icacls.exe', [path, '/grant', '*S-1-1-0:(F)', '*S-1-5-32-545:(F)'], { encoding: 'utf8', windowsHide: true });
    execFileSync('icacls.exe', [path, '/deny', '*S-1-1-0:(WA)', '*S-1-5-32-545:(WA)'], { encoding: 'utf8', windowsHide: true });
  }
});

async function launch(extraEnv: Record<string, string> = {}): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.OI_USER_DATA_DIR = userData;
  env.OI_RENDERER_ROOT = 'e2e-electron/fixtures/shell-page';
  env.OI_E2E_DISABLE_PROTOCOL_REGISTRATION = '1';
  Object.assign(env, extraEnv);
  electronApp = await _electron.launch({ args: ['dist-electron/main/index.cjs'], env });
}

test.afterEach(async () => {
  if (electronApp) await electronApp.close();
  const secretsDir = join(userData, 'secrets');
  try {
    if (!(await lstat(secretsDir)).isSymbolicLink()) {
      for (const path of [secretsDir, join(secretsDir, 'acl-probe.txt'), join(secretsDir, 'root.secret'), join(secretsDir, 'nested'), join(secretsDir, 'nested', 'nested-probe.txt'), join(secretsDir, 'nested', 'first.secret'), join(secretsDir, 'nested', 'second.secret')]) {
        execFileSync('icacls.exe', [path, '/remove:d', '*S-1-1-0', '*S-1-5-32-545'], { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
      }
      execFileSync('icacls.exe', [secretsDir, '/reset', '/T', '/C'], { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
    }
  } catch { /* already absent, or a junction deliberately left untouched */ }
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test('real safeStorage round-trip works and removes pre-existing broad ACL grants', async () => {
  const secretsDir = join(userData, 'secrets');
  await launch();
  page = await electronApp.firstWindow();
  await expect(page.locator('#status')).toHaveText('Shell checks complete');
  const encryptedRoundTrip = await electronApp.evaluate(({ safeStorage }) => {
    const secret = `real-safe-storage-${Date.now()}`;
    return safeStorage.decryptString(safeStorage.encryptString(secret)) === secret;
  });
  expect(encryptedRoundTrip).toBe(true);

  const value = `ipc-secret-${Date.now()}`;
  const persisted = await page.evaluate(async (secret) => {
    const bridge = Reflect.get(window, 'oiDesktop') as { secrets: { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void> } };
    await bridge.secrets.set('e2e-secret', secret);
    return bridge.secrets.get('e2e-secret');
  }, value);
  expect(persisted).toBe(value);

  const files = await readdir(secretsDir);
  expect(files.filter((file) => file.endsWith('.secret') && file !== 'root.secret')).toHaveLength(1);
  const encryptedFile = files.find((file) => file.endsWith('.secret') && file !== 'root.secret');
  expect(encryptedFile).toBeDefined();
  const bytes = await readFile(join(secretsDir, encryptedFile!));
  expect(bytes.includes(Buffer.from(value))).toBe(false);
  expect(bytes.toString('utf8')).not.toContain(Buffer.from(value).toString('base64'));
  const nestedDir = join(secretsDir, 'nested');
  const aclPaths = [secretsDir, ...files.map((file) => join(secretsDir, file)), nestedDir, ...(await readdir(nestedDir)).map((file) => join(nestedDir, file))];
  for (const path of aclPaths) {
    const rules = aclRules(path);
    expect(rules.some((rule) => rule.sid === 'S-1-1-0' || rule.sid === 'S-1-5-32-545')).toBe(false);
  }
  await expect(readFile(join(secretsDir, 'acl-probe.txt'), 'utf8')).resolves.toBe('pre-existing data remains readable');
  await expect(readFile(join(secretsDir, 'nested', 'nested-probe.txt'), 'utf8')).resolves.toBe('nested pre-existing data remains readable');
});

test('safeStorage unavailability exits before opening a window or touching secret data', async () => {
  const secretsDir = join(userData, 'secrets');
  const sentinel = join(secretsDir, 'existing.secret');
  const secretBytes = Buffer.from('existing-ciphertext');
  await writeFile(sentinel, secretBytes);
  await launch({ OI_TEST_SAFE_STORAGE_UNAVAILABLE: '1' });
  const child = electronApp.process();
  await electronApp.waitForEvent('close', { timeout: 10_000 });
  expect(child.exitCode).toBe(1);
  expect(electronApp.windows()).toEqual([]);
  await expect(readFile(sentinel)).resolves.toEqual(secretBytes);
});

test('a final ACL failure exits with the broad-read deny barrier covering the existing tree', async () => {
  const sentinel = join(userData, 'secrets', 'acl-probe.txt');
  await launch({ OI_TEST_FAIL_ACL_STEP: 'final-acl' });
  const child = electronApp.process();
  await electronApp.waitForEvent('close', { timeout: 10_000 });
  expect(child.exitCode).toBe(1);
  expect(electronApp.windows()).toEqual([]);
  await expect(readFile(sentinel, 'utf8')).rejects.toThrow();
  for (const path of [sentinel, join(userData, 'secrets', 'nested', 'nested-probe.txt')]) {
    const rules = aclRules(path);
    for (const sid of ['S-1-1-0', 'S-1-5-32-545']) {
      expect(rules.some((rule) => rule.sid === sid && rule.access === 'Deny' && hasRights(rule, 1))).toBe(true);
    }
  }
});

test('an injected partial barrier runner failure is repaired across all files before startup continues', async () => {
  const paths = [
    join(userData, 'secrets', 'root.secret'),
    join(userData, 'secrets', 'nested', 'first.secret'),
    join(userData, 'secrets', 'nested', 'second.secret'),
  ];
  for (const path of [join(userData, 'secrets'), join(userData, 'secrets', 'nested'), ...paths]) {
    const rules = aclRules(path);
    for (const sid of ['S-1-1-0', 'S-1-5-32-545']) {
      expect(rules.some((rule) => rule.sid === sid && rule.access === 'Deny' && hasRights(rule, 256))).toBe(true);
      expect(rules.some((rule) => rule.sid === sid && rule.access === 'Allow' && hasRights(rule, 1))).toBe(true);
    }
    if (path === join(userData, 'secrets') || path === join(userData, 'secrets', 'nested')) {
      await expect(readdir(path)).resolves.toBeDefined();
    } else {
      await expect(readFile(path)).resolves.toBeDefined();
    }
  }
  await launch({ OI_TEST_FAIL_ACL_STEP: 'barrier-partial' });
  page = await electronApp.firstWindow();
  await expect(page.locator('#status')).toHaveText('Shell checks complete');

  const protectedPaths = [join(userData, 'secrets'), join(userData, 'secrets', 'acl-probe.txt'), ...paths, join(userData, 'secrets', 'nested'), join(userData, 'secrets', 'nested', 'nested-probe.txt')];
  for (const path of paths) {
    await expect(readFile(path)).resolves.toBeDefined();
  }
  const userSid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-\d+(?:-\d+)+/)?.[0];
  expect(userSid).toBeDefined();
  for (const path of protectedPaths) {
    const rules = aclRules(path);
    expect(rules.some((rule) => rule.sid === 'S-1-1-0')).toBe(false);
    expect(rules.some((rule) => rule.sid === 'S-1-5-32-545')).toBe(false);
    for (const sid of [userSid!, 'S-1-5-18', 'S-1-5-32-544']) {
      expect(rules.some((rule) => rule.sid === sid && rule.access === 'Allow' && hasRights(rule, 2032127))).toBe(true);
    }
  }
});

test('a junction secrets directory is rejected by read-only reparse detection before ACL repair', async () => {
  const secretsDir = join(userData, 'secrets');
  const targetDir = join(userData, 'junction-target');
  for (const path of [secretsDir, join(secretsDir, 'acl-probe.txt'), join(secretsDir, 'root.secret'), join(secretsDir, 'nested'), join(secretsDir, 'nested', 'nested-probe.txt'), join(secretsDir, 'nested', 'first.secret'), join(secretsDir, 'nested', 'second.secret')]) {
    execFileSync('icacls.exe', [path, '/remove:d', '*S-1-1-0', '*S-1-5-32-545'], { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
  }
  await rm(secretsDir, { recursive: true, force: true });
  await mkdir(targetDir);
  const targetFile = join(targetDir, 'untouched.txt');
  await writeFile(targetFile, 'junction target remains untouched');
  const targetAclBefore = execFileSync('icacls.exe', [targetDir], { encoding: 'utf8', windowsHide: true });
  await symlink(targetDir, secretsDir, 'junction');
  const reparseProbe = spawnSync('fsutil.exe', ['reparsepoint', 'query', secretsDir], { encoding: 'utf8', windowsHide: true });
  expect(reparseProbe.status).toBe(0);
  expect(`${reparseProbe.stdout}${reparseProbe.stderr}`).toMatch(/Reparse Tag Value/i);

  await launch();
  const child = electronApp.process();
  await electronApp.waitForEvent('close', { timeout: 10_000 });
  expect(child.exitCode).toBe(1);
  expect(electronApp.windows()).toEqual([]);
  await expect(readFile(targetFile, 'utf8')).resolves.toBe('junction target remains untouched');
  expect(execFileSync('icacls.exe', [targetDir], { encoding: 'utf8', windowsHide: true })).toBe(targetAclBefore);
});
