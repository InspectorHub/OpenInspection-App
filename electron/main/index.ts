import { app, BrowserWindow, Menu, net, protocol, session, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAppOriginHandler, createHttpsPassthrough } from './app-origin.ts';
import { createLogger } from './logger.ts';
import { resolveStartupPaths } from './paths.ts';
import { applyNavigationRequestPolicy, applyPermissionPolicy } from './security.ts';
import { createSingleInstance } from './single-instance.ts';
import { createWindowController } from './window.ts';

const paths = resolveStartupPaths({ packaged: app.isPackaged, appData: app.getPath('appData'), appPath: app.getAppPath(), env: process.env });
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
  void app.whenReady().then(() => {
    applyNavigationRequestPolicy(session.defaultSession);
    applyPermissionPolicy(session.defaultSession);
    protocol.handle('https', createAppOriginHandler({ rendererRoot: paths.rendererRoot, readFile, passthrough: createHttpsPassthrough(net), packaged: app.isPackaged }));
    log('startup');
    windows.ensure();
    app.on('activate', windows.ensure);
  }).catch(() => { log('startup-failed'); app.exit(1); });
  app.on('window-all-closed', () => app.quit());
}
