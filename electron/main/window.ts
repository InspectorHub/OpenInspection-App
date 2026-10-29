import type { BrowserWindowConstructorOptions, Event as ElectronEvent } from 'electron';
import { APP_ORIGIN } from './app-origin.ts';
import type { LogEvent } from './logger.ts';
import { applyNavigationGuards, type WindowLike } from './security.ts';

export interface ShellWindow extends WindowLike {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isFocused(): boolean;
  restore(): void;
  focus(): void;
  setProgressBar(value: number, options?: { mode: 'normal' | 'error' | 'none' }): void;
  loadURL(url: string): Promise<void>;
  on(event: 'close', listener: (event: ElectronEvent) => void): unknown;
  on(event: 'closed' | 'focus' | 'restore' | 'show' | 'minimize' | 'hide', listener: () => void): unknown;
}

export function createWindowController(deps: {
  packaged: boolean;
  preload: string;
  create(options: BrowserWindowConstructorOptions): ShellWindow;
  setApplicationMenu(menu: null): void;
  openExternal(url: string): Promise<void>;
  log(event: LogEvent): void;
  onCreated?(window: ShellWindow): void | (() => void);
  onActiveChange?(active: boolean): void;
}): { ensure(): void; focus(): void } {
  let window: ShellWindow | undefined;
  let closing = false;
  return {
    ensure() {
      if (window && !window.isDestroyed()) return;
      if (deps.packaged) deps.setApplicationMenu(null);
      const created = deps.create({
        width: 1280, height: 800, minWidth: 480, minHeight: 640, title: 'InspectorHub',
        webPreferences: { preload: deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true,
          allowRunningInsecureContent: false, backgroundThrottling: false, devTools: !deps.packaged, spellcheck: false, webviewTag: false },
      });
      window = created;
      const dispose = deps.onCreated?.(created);
      created.on('focus', () => deps.onActiveChange?.(true));
      created.on('restore', () => deps.onActiveChange?.(true));
      created.on('show', () => deps.onActiveChange?.(true));
      created.on('minimize', () => deps.onActiveChange?.(false));
      created.on('hide', () => deps.onActiveChange?.(false));
      closing = false;
      applyNavigationGuards(created, deps);
      let closeAttempt = 0;
      created.on('close', (event) => {
        const attempt = ++closeAttempt;
        closing = true;
        setImmediate(() => {
          if (event.defaultPrevented && attempt === closeAttempt && window === created && !created.isDestroyed()) closing = false;
        });
      });
      created.on('closed', () => {
        dispose?.();
        if (window === created) window = undefined;
      });
      void created.loadURL(APP_ORIGIN).then(() => { deps.log('window-ready'); }).catch(() => { deps.log('renderer-load-failed'); });
    },
    focus() {
      const current = window;
      if (!current || current.isDestroyed() || closing) return;
      if (current.isMinimized()) current.restore();
      if (!current.isDestroyed() && !closing) current.focus();
    },
  };
}
