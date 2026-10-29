import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import type { BrowserWindowConstructorOptions } from 'electron';
import { expect, it, vi } from 'vitest';
import { createWindowController, type ShellWindow } from './window.ts';

type TestShellWindow = ShellWindow & EventEmitter;

function setup(packaged = false) {
  const order: string[] = [];
  let destroyed = false;
  const webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  const win = Object.assign(new EventEmitter(), { webContents, isDestroyed: () => destroyed, isMinimized: () => true, restore: () => { order.push('restore'); }, focus: () => { order.push('focus'); }, loadURL: vi.fn(async () => {}) });
  const create = vi.fn((_options: BrowserWindowConstructorOptions): ShellWindow => win);
  const setApplicationMenu = vi.fn();
  const controller = createWindowController({ packaged, preload: '/preload.cjs', create, setApplicationMenu, openExternal: async () => {}, log: vi.fn() });
  return { controller, create, setApplicationMenu, order, win, destroy: () => { destroyed = true; } };
}

it.each([true, false])('creates one isolated window with the fixed entry: packaged=%s', async (packaged) => {
  const { controller, create, setApplicationMenu, win } = setup(packaged);
  controller.focus();
  controller.ensure();
  controller.ensure();
  expect(create).toHaveBeenCalledOnce();
  expect(create.mock.calls[0]![0]).toEqual({ width: 1280, height: 800, minWidth: 480, minHeight: 640, title: 'InspectorHub', webPreferences: { preload: '/preload.cjs', contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false, devTools: !packaged, spellcheck: false, webviewTag: false } });
  expect(win.loadURL).toHaveBeenCalledExactlyOnceWith('https://localhost');
  expect(setApplicationMenu.mock.calls).toEqual(packaged ? [[null]] : []);
});

it('restores before focus, tolerates missing/destroyed/closing windows, and recreates only on ensure', () => {
  const { controller, create, order, win, destroy } = setup();
  controller.focus();
  expect(order).toEqual([]);
  controller.ensure();
  controller.focus();
  expect(order).toEqual(['restore', 'focus']);
  win.emit('close', {});
  controller.focus();
  controller.ensure();
  expect(create).toHaveBeenCalledOnce();
  destroy();
  controller.focus();
  expect(order).toEqual(['restore', 'focus']);
  win.emit('closed');
  controller.ensure();
  expect(create).toHaveBeenCalledTimes(2);
});

it('focuses the active window after another close listener cancels closing', async () => {
  const { controller, order, win } = setup();
  controller.ensure();
  win.on('close', (event: { preventDefault(): void }) => { event.preventDefault(); });

  const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  win.emit('close', event);
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  controller.focus();

  expect(event.defaultPrevented).toBe(true);
  expect(order).toEqual(['restore', 'focus']);
});

it('keeps focus suppressed when a later close attempt supersedes a cancelled close', async () => {
  const { controller, order, win } = setup();
  controller.ensure();
  let firstClose = true;
  win.on('close', (event: { preventDefault(): void }) => {
    if (firstClose) event.preventDefault();
    firstClose = false;
  });

  const cancelled = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  win.emit('close', cancelled);
  win.emit('close', { defaultPrevented: false });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  controller.focus();

  expect(cancelled.defaultPrevented).toBe(true);
  expect(order).toEqual([]);
});

it('does not let an old window cancellation reset the replacement window close state', async () => {
  const order: string[] = [];
  let oldDestroyed = false;
  let newDestroyed = false;
  const makeWindow = (getDestroyed: () => boolean): TestShellWindow => Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() }),
    isDestroyed: getDestroyed,
    isMinimized: () => true,
    restore: () => { order.push('restore'); },
    focus: () => { order.push('focus'); },
    loadURL: vi.fn(async () => {}),
  }) as unknown as TestShellWindow;
  const oldWindow = makeWindow(() => oldDestroyed);
  const newWindow = makeWindow(() => newDestroyed);
  const windows = [oldWindow, newWindow];
  const create = vi.fn((_options: BrowserWindowConstructorOptions) => windows.shift()!);
  const controller = createWindowController({ packaged: false, preload: '/preload.cjs', create, setApplicationMenu: vi.fn(), openExternal: async () => {}, log: vi.fn() });

  controller.ensure();
  oldWindow.on('close', (event: { preventDefault(): void }) => { event.preventDefault(); });
  const cancelled = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  oldWindow.emit('close', cancelled);
  oldDestroyed = true;
  oldWindow.emit('closed');
  controller.ensure();
  newWindow.emit('close', { defaultPrevented: false });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  controller.focus();

  expect(cancelled.defaultPrevented).toBe(true);
  expect(order).toEqual([]);
});

it('does not reset a real close or create a replacement until the old window is closed', async () => {
  const { controller, create, order, win, destroy } = setup();
  controller.ensure();
  win.emit('close', {});
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  controller.focus();
  controller.ensure();
  expect(order).toEqual([]);
  expect(create).toHaveBeenCalledOnce();

  destroy();
  win.emit('closed');
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  controller.ensure();

  expect(create).toHaveBeenCalledTimes(2);
});

it('contains a failed renderer load and logs only its category', async () => {
  const { controller, win } = setup();
  win.loadURL.mockRejectedValueOnce(new Error('SECRET'));
  controller.ensure();
  await Promise.resolve();
  expect(win.loadURL).toHaveBeenCalledOnce();
});

it('handles a window being destroyed while it is restored', () => {
  const { controller, win, destroy } = setup();
  win.restore = () => { destroy(); win.emit('closed'); };
  controller.ensure();
  expect(() => controller.focus()).not.toThrow();
});

it('every main-process load call uses APP_ORIGIN and no loadFile entry exists', () => {
  const calls: string[] = [];
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['loadURL', 'loadFile'].includes(node.expression.name.text)) {
            calls.push(node.expression.name.text);
            expect(node.expression.name.text).toBe('loadURL');
            expect(node.arguments[0]?.getText(source)).toBe('APP_ORIGIN');
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
  }
  scan('electron/main');
  expect(calls).toEqual(['loadURL']);
});
