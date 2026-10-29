import { beforeEach, expect, it, vi } from 'vitest';

const state = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return { locked: true, order: [] as string[], ready: Promise.resolve(), create: vi.fn(), app: new EventEmitter() };
});
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), mkdirSync: vi.fn(() => { state.order.push('mkdir'); }) }));
vi.mock('electron', () => ({
  app: Object.assign(state.app, {
    isPackaged: false,
    getPath: () => 'appdata', getAppPath: () => process.cwd(), setPath: vi.fn(() => { state.order.push('set-path'); }),
    requestSingleInstanceLock: () => { state.order.push('lock'); return state.locked; },
    exit: vi.fn(), quit: vi.fn(), whenReady: () => { state.order.push('ready'); return state.ready; },
  }),
  protocol: { registerSchemesAsPrivileged: vi.fn(() => { state.order.push('privileged'); }), handle: vi.fn(() => { state.order.push('handler'); }) },
  session: { defaultSession: { webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  BrowserWindow: class { constructor(options: unknown) { state.create(options); } },
  Menu: { setApplicationMenu: vi.fn() }, net: { fetch: vi.fn() }, shell: { openExternal: vi.fn() },
}));
vi.mock('./window.ts', () => ({ createWindowController: () => ({ ensure: () => state.create(), focus: vi.fn() }) }));
vi.mock('./logger.ts', () => ({ createLogger: () => vi.fn() }));

beforeEach(() => { vi.resetModules(); state.order.length = 0; state.app.removeAllListeners(); state.create.mockClear(); state.locked = true; state.ready = Promise.resolve(); });

it('stops all ready/protocol/window setup after a failed lock', async () => {
  state.locked = false;
  await import('./index.ts');
  expect(state.order).toEqual(['mkdir', 'set-path', 'lock']);
  expect(state.create).not.toHaveBeenCalled();
});

it('registers media privileges before readiness and sets up once after readiness', async () => {
  let ready = (): void => {};
  state.ready = new Promise<void>((resolve) => { ready = resolve; });
  await import('./index.ts');
  expect(state.order).toEqual(['mkdir', 'set-path', 'lock', 'privileged', 'ready']);
  expect(state.create).not.toHaveBeenCalled();
  ready();
  await state.ready;
  await Promise.resolve();
  expect(state.order).toEqual(['mkdir', 'set-path', 'lock', 'privileged', 'ready', 'handler']);
  expect(state.create).toHaveBeenCalledOnce();
});
