import { app, BrowserWindow, Menu, net, protocol, safeStorage, session, shell, ipcMain } from 'electron';
import { mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppOriginHandler, createHttpsPassthrough } from './app-origin.ts';
import { createKvHost } from './data/kv.ts';
import { createSecretsHost, ensureSecretsDirectory, SecretsUnavailableError } from './data/secrets.ts';
import { secureSecretsAcl, type SecurityCommand } from './data/windows-security.ts';
import { IpcError } from '../shared/ipc-contract.ts';
import { registerHandler } from './ipc/register.ts';
import { validators } from './ipc/validate.ts';
import { createLogger } from './logger.ts';
import { resolveStartupPaths } from './paths.ts';
import { applyNavigationRequestPolicy, applyPermissionPolicy } from './security.ts';
import { createSingleInstance } from './single-instance.ts';
import { createWindowController } from './window.ts';

const paths = resolveStartupPaths({ packaged: app.isPackaged, appData: app.getPath('appData'), appPath: app.getAppPath(), env: process.env });
const runSecurityCommand: SecurityCommand = (command, args) => {
  if (!app.isPackaged && command === 'powershell.exe' && args[3]?.includes("$mode = 'final'") && process.env.OI_TEST_FAIL_ACL_STEP === 'final-acl') {
    return { status: 5, stdout: '', stderr: 'injected ACL failure' };
  }
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
};
mkdirSync(paths.userData, { recursive: true });
app.setPath('userData', paths.userData);
let focus = (): void => {};
let onSecond = (_argv: readonly string[]): void => {};

if (createSingleInstance({ app, onSecond: (argv) => onSecond(argv), focus: () => focus() })) {
  const log = createLogger(paths.userData);
  onSecond = () => log('second-instance');
  const windows = createWindowController({ packaged: app.isPackaged, preload: join(__dirname, '../preload/index.cjs'),
    create: (options) => new BrowserWindow(options), setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
    openExternal: (url) => shell.openExternal(url), log });
  focus = windows.focus;
  protocol.registerSchemesAsPrivileged([{ scheme: 'oi-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
  void app.whenReady().then(async () => {
    const forcedUnavailable = !app.isPackaged && process.env.OI_TEST_SAFE_STORAGE_UNAVAILABLE === '1';
    if (forcedUnavailable || !safeStorage.isEncryptionAvailable()) throw new SecretsUnavailableError();
    const secretsDir = join(paths.userData, 'secrets');
    const isWindows = process.platform === 'win32';
    await ensureSecretsDirectory(fs, secretsDir, { windows: isWindows, run: runSecurityCommand });
    if (isWindows) await secureSecretsAcl({
      dir: secretsDir,
      run: runSecurityCommand,
      barrierRunner: !app.isPackaged && process.env.OI_TEST_FAIL_ACL_STEP === 'barrier-partial'
        ? (files, applyBarrier) => {
          for (const file of files.slice(0, 1)) applyBarrier(file);
          return { status: 5, stdout: '', stderr: 'injected partial barrier runner failure' };
        }
        : undefined,
      listPaths: async () => {
        const paths: Array<{ path: string; directory: boolean }> = [];
        const visit = async (directory: string): Promise<void> => {
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isSymbolicLink()) throw new Error('secrets-reparse-point');
            paths.push({ path, directory: entry.isDirectory() });
            if (entry.isDirectory()) await visit(path);
          }
        };
        await visit(secretsDir);
        return paths;
      },
    });
    applyNavigationRequestPolicy(session.defaultSession);
    applyPermissionPolicy(session.defaultSession);
    protocol.handle('https', createAppOriginHandler({ rendererRoot: paths.rendererRoot, readFile, passthrough: createHttpsPassthrough(net), packaged: app.isPackaged }));
    const secrets = createSecretsHost({ safeStorage, fs, dir: secretsDir });
    if (!secrets.available) throw new SecretsUnavailableError();
    const kv = createKvHost({ fs, file: join(paths.userData, 'kv.json') });
    const registerDeps = { ipcMain, log };
    registerHandler(registerDeps, 'secrets:get', validators.secrets.get, async (key) => secrets.get(key));
    registerHandler(registerDeps, 'secrets:set', validators.secrets.set, async (key, value) => {
      try { await secrets.set(key, value); }
      catch (error) { if (error instanceof SecretsUnavailableError) throw new IpcError('unavailable'); throw error; }
    });
    registerHandler(registerDeps, 'secrets:remove', validators.secrets.remove, async (key) => secrets.remove(key));
    registerHandler(registerDeps, 'kv:get', validators.kv.get, async (key) => kv.get(key));
    registerHandler(registerDeps, 'kv:set', validators.kv.set, async (key, value) => kv.set(key, value));
    log('startup');
    windows.ensure();
    app.on('activate', windows.ensure);
  }).catch(() => { log('startup-failed'); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
