import { app, BrowserWindow, Menu, net, protocol, safeStorage, session, shell, ipcMain } from 'electron';
import { mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppOriginHandler, createHttpsPassthrough, isAppOrigin } from './app-origin.ts';
import { createKvHost } from './data/kv.ts';
import { createFilesHost } from './data/files-host.ts';
import { createMediaFileResolver, createUploaderHost } from './net/uploader-host.ts';
import { createUploadTransport } from './net/upload-transport.ts';
import { createMediaFileResponse, createMediaProtocolHandler } from './data/media-protocol.ts';
import { createSecretsHost, ensureSecretsDirectory, SecretsUnavailableError } from './data/secrets.ts';
import { openDesktopDb, openNativeSqlite, setAsideUnreadableDatabase } from './data/db-open.ts';
import { watchRendererDbLifecycle, type DbHost } from './data/db-host.ts';
import { secureSecretsAcl, type SecurityCommand } from './data/windows-security.ts';
import { AUTH_CALLBACK_READY_CHANNEL, EVENT_CHANNELS, IpcError } from '../shared/ipc-contract.ts';
import { registerHandler } from './ipc/register.ts';
import { validators } from './ipc/validate.ts';
import { createLogger } from './logger.ts';
import { resolveStartupPaths } from './paths.ts';
import { applyNavigationRequestPolicy, applyPermissionPolicy } from './security.ts';
import { createSingleInstance } from './single-instance.ts';
import { createWindowController } from './window.ts';
import { createDeepLinkHub, extractCallbackUrl } from './auth/deep-link.ts';
import { isAllowedExternalUrl } from './auth/open-external.ts';
import { registerProtocolClient } from './auth/protocol-client.ts';

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
let dbHost: DbHost | null = null;
let filesHost: ReturnType<typeof createFilesHost> | null = null;
let uploaderHost: ReturnType<typeof createUploaderHost> | null = null;
let uploaderContents: { send(channel: string, payload: unknown): void } | null = null;
let dbOpening: Promise<{ outcome: Awaited<ReturnType<typeof openDesktopDb>>['outcome']; host: DbHost | null }> | null = null;
const deepLinks = createDeepLinkHub();
const coldCallback = extractCallbackUrl(process.argv);
if (coldCallback) deepLinks.push(coldCallback);

app.on('open-url', (event, url) => {
  event.preventDefault();
  deepLinks.push(url);
});

if (createSingleInstance({ app, onSecond: (argv) => onSecond(argv), focus: () => focus() })) {
  const log = createLogger(paths.userData);
  const callbackSubscriptions = new WeakMap<object, () => void>();
  ipcMain.on(AUTH_CALLBACK_READY_CHANNEL, (event) => {
    if (event.senderFrame === null || event.senderFrame.parent !== null || !isAppOrigin(event.senderFrame.url)) return;
    const sender = event.sender;
    callbackSubscriptions.get(sender)?.();
    const unsubscribe = deepLinks.subscribe((url) => {
      if (!sender.isDestroyed()) sender.send(EVENT_CHANNELS.authCallback, url);
    });
    callbackSubscriptions.set(sender, unsubscribe);
    sender.once('destroyed', () => {
      unsubscribe();
      callbackSubscriptions.delete(sender);
    });
  });
  onSecond = (argv) => {
    const callback = extractCallbackUrl(argv);
    if (callback) deepLinks.push(callback);
    log('second-instance');
  };
  const windows = createWindowController({ packaged: app.isPackaged, preload: join(__dirname, '../preload/index.cjs'),
    create: (options) => new BrowserWindow(options), setApplicationMenu: (menu) => Menu.setApplicationMenu(menu),
    openExternal: (url) => isAllowedExternalUrl(url, { packaged: app.isPackaged }) ? shell.openExternal(url) : Promise.resolve(), log,
    onCreated: (win) => {
      const currentContents = win.webContents as unknown as { send(channel: string, payload: unknown): void };
      uploaderContents = currentContents;
      const contents = win.webContents as unknown as { on(event: string, listener: () => void): unknown };
      watchRendererDbLifecycle(contents, () => dbHost);
      contents.on('destroyed', () => { void filesHost?.abortAll(); uploaderHost?.abortAll('quit'); if (uploaderContents === currentContents) uploaderContents = null; });
      contents.on('render-process-gone', () => { void filesHost?.abortAll(); uploaderHost?.abortAll('quit'); });
    } });
  focus = windows.focus;
  protocol.registerSchemesAsPrivileged([{ scheme: 'oi-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
  void app.whenReady().then(async () => {
    if (app.isPackaged || process.env.OI_E2E_DISABLE_PROTOCOL_REGISTRATION !== '1') {
      const removeProtocolRegistration = registerProtocolClient({ app, packaged: app.isPackaged, execPath: process.execPath, argv: process.argv });
      app.on('will-quit', removeProtocolRegistration);
    }
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
    const registerDeps = { ipcMain, log };
    applyNavigationRequestPolicy(session.defaultSession);
    applyPermissionPolicy(session.defaultSession);
    protocol.handle('https', createAppOriginHandler({ rendererRoot: paths.rendererRoot, readFile, passthrough: createHttpsPassthrough(net), packaged: app.isPackaged }));
    filesHost = createFilesHost({ fs, mediaRoot: join(paths.userData, 'media'), cacheRoot: join(paths.userData, 'cache'), clock: { now: Date.now, setTimeout, clearTimeout } });
    uploaderHost = createUploaderHost({ transport: createUploadTransport(), resolveMediaFile: createMediaFileResolver({ fs, mediaRoot: join(paths.userData, 'media'), cacheRoot: join(paths.userData, 'cache') }),
      timers: { setTimeout, clearTimeout }, random: Math.random, packaged: app.isPackaged });
    uploaderHost.onEvent((event) => { try { uploaderContents?.send(EVENT_CHANNELS.uploaderEvent, event); } catch { /* renderer lifecycle can race a completion */ } });
    protocol.handle('oi-media', createMediaProtocolHandler({
      mediaRoot: join(paths.userData, 'media'),
      fetchFile: createMediaFileResponse,
    }));
    const files = filesHost;
    registerHandler(registerDeps, 'files:write', validators.files.write, async (path, bytes) => files.write(path, bytes));
    registerHandler(registerDeps, 'files:size', validators.files.size, async (path) => files.size(path));
    registerHandler(registerDeps, 'files:read', validators.files.read, async (path) => files.read(path));
    registerHandler(registerDeps, 'files:remove', validators.files.remove, async (path) => files.remove(path));
    registerHandler(registerDeps, 'files:display-url', validators.files.displayUrl, async (path) => files.displayUrl(path));
    registerHandler(registerDeps, 'files:file-uri', validators.files.fileUri, async (path) => files.fileUri(path));
    registerHandler(registerDeps, 'files:exists', validators.files.exists, async (path) => files.exists(path));
    registerHandler(registerDeps, 'files:list', validators.files.list, async (path) => files.list(path));
    registerHandler(registerDeps, 'files:remove-cache', validators.files.removeCache, async (path) => files.removeCache(path));
    registerHandler(registerDeps, 'files:list-cache', validators.files.listCache, async () => files.listCache());
    registerHandler(registerDeps, 'files:stream-open', validators.files.streamOpen, async (area, path) => files.stream.open(area, path));
    registerHandler(registerDeps, 'files:stream-append', validators.files.streamAppend, async (handle, chunk) => files.stream.append(handle, chunk));
    registerHandler(registerDeps, 'files:stream-finish', validators.files.streamFinish, async (handle, outcome) => files.stream.finish(handle, outcome));
    registerHandler(registerDeps, 'shell:open-external', validators.shell.openExternal, async (url) => {
      if (!isAllowedExternalUrl(url, { packaged: app.isPackaged })) throw new IpcError('invalid-argument');
      await shell.openExternal(url);
    });
    const uploader = uploaderHost;
    registerHandler(registerDeps, 'uploader:start', validators.uploader.start, async (options) => uploader.start(options));
    registerHandler(registerDeps, 'uploader:remove', validators.uploader.remove, async (id) => uploader.remove(id));
    const secrets = createSecretsHost({ safeStorage, fs, dir: secretsDir });
    if (!secrets.available) throw new SecretsUnavailableError();
    const kv = createKvHost({ fs, file: join(paths.userData, 'kv.json') });
    registerHandler(registerDeps, 'secrets:get', validators.secrets.get, async (key) => secrets.get(key));
    registerHandler(registerDeps, 'secrets:set', validators.secrets.set, async (key, value) => {
      try { await secrets.set(key, value); }
      catch (error) { if (error instanceof SecretsUnavailableError) throw new IpcError('unavailable'); throw error; }
    });
    registerHandler(registerDeps, 'secrets:remove', validators.secrets.remove, async (key) => secrets.remove(key));
    registerHandler(registerDeps, 'kv:get', validators.kv.get, async (key) => kv.get(key));
    registerHandler(registerDeps, 'kv:set', validators.kv.set, async (key, value) => kv.set(key, value));
    const openDb = async () => {
      dbOpening ??= openDesktopDb({ dbDir: join(paths.userData, 'db'), secrets, fs, open: openNativeSqlite, now: Date.now, log });
      const result = await dbOpening;
      dbHost = result.host;
      return result.outcome;
    };
    const requireDb = (): DbHost => {
      if (dbHost === null) throw new IpcError('unavailable');
      return dbHost;
    };
    registerHandler(registerDeps, 'db:open', validators.db.open, async () => openDb());
    registerHandler(registerDeps, 'db:execute', validators.db.execute, async (sql) => { requireDb().execute(sql); });
    registerHandler(registerDeps, 'db:query', validators.db.query, async (sql, params) => requireDb().query(sql, params ?? []));
    registerHandler(registerDeps, 'db:run', validators.db.run, async (sql, params) => requireDb().run(sql, params ?? []));
    registerHandler(registerDeps, 'db:begin', validators.db.begin, async () => { requireDb().begin(); });
    registerHandler(registerDeps, 'db:commit', validators.db.commit, async () => { requireDb().commit(); });
    registerHandler(registerDeps, 'db:rollback', validators.db.rollback, async () => { requireDb().rollback(); });
    registerHandler(registerDeps, 'db:in-transaction', validators.db.inTransaction, async () => requireDb().inTransaction());
    registerHandler(registerDeps, 'db:close', validators.db.close, async () => { dbHost?.close(); dbHost = null; dbOpening = null; });
    registerHandler(registerDeps, 'db:set-aside-unreadable', validators.db.setAsideUnreadable, async () => {
      const result = await openDb();
      if (result.ok || result.reason !== 'key-unreadable') throw new IpcError('unavailable');
      try {
        await setAsideUnreadableDatabase({ dbDir: join(paths.userData, 'db'), secrets, fs, now: Date.now });
      } catch {
        throw new IpcError('unavailable');
      }
      dbOpening = null; dbHost = null;
    });
    registerHandler(registerDeps, 'shell:open-data-folder', validators.shell.openDataFolder, async () => {
      const result = await shell.openPath(join(paths.userData, 'db'));
      if (result !== '') throw new Error('open-data-folder-failed');
    });
    log('startup');
    windows.ensure();
    app.on('activate', windows.ensure);
  }).catch(() => { log('startup-failed'); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
