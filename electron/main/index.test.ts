import { beforeEach, expect, it, vi } from 'vitest';

const state = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  return { locked: true, safeStorageAvailable: true, secretsDirExists: false, secretsDirIsLink: false, secretsDirIsReparse: false, aclDenied: false, order: [] as string[], ready: Promise.resolve(), create: vi.fn(), handle: vi.fn(), spawn: vi.fn((command: string, args: string[] = []) => {
    if (command === 'icacls.exe' && args.includes('/deny')) state.aclDenied = true;
    if (command === 'icacls.exe' && args.includes('/remove:d')) state.aclDenied = false;
    if (command === 'powershell.exe') state.aclDenied = args[3]?.includes("$mode = 'barrier'") ?? false;
    return command === 'fsutil.exe' ? ({ status: state.secretsDirIsReparse ? 0 : 1, stdout: state.secretsDirIsReparse ? 'Reparse Tag Value : 0xa0000003' : 'Error 4390: not a reparse point', stderr: '' }) : command === 'whoami.exe' ? ({ status: 0, stdout: '"user" "S-1-5-21-1-2-3-1001"', stderr: '' }) : ({ status: 0, stdout: args.length === 1 && state.aclDenied ? 'Everyone:(DENY)(RD)\nBUILTIN\\Users:(DENY)(RD)' : '', stderr: '' });
  }), app: new EventEmitter() };
});
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), mkdirSync: vi.fn(() => { state.order.push('mkdir'); }) }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  lstat: vi.fn(async () => {
    if (!state.secretsDirExists) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { isSymbolicLink: () => state.secretsDirIsLink };
  }),
  mkdir: vi.fn(async () => { state.order.push('mkdir-secrets'); state.secretsDirExists = true; }),
  readdir: vi.fn(async () => []),
}));
vi.mock('node:child_process', () => ({ spawnSync: state.spawn }));
vi.mock('electron', () => ({
  app: Object.assign(state.app, {
    isPackaged: false,
    getPath: () => 'appdata', getAppPath: () => process.cwd(), setPath: vi.fn(() => { state.order.push('set-path'); }),
    requestSingleInstanceLock: () => { state.order.push('lock'); return state.locked; },
    exit: vi.fn(), quit: vi.fn(), whenReady: () => { state.order.push('ready'); return state.ready; },
  }),
  protocol: { registerSchemesAsPrivileged: vi.fn(() => { state.order.push('privileged'); }), handle: vi.fn(() => { state.order.push('handler'); }) },
  ipcMain: { handle: state.handle }, safeStorage: { isEncryptionAvailable: () => state.safeStorageAvailable, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  session: { defaultSession: { webRequest: { onBeforeRequest: vi.fn() }, setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
  BrowserWindow: class { constructor(options: unknown) { state.create(options); } },
  Menu: { setApplicationMenu: vi.fn() }, net: { fetch: vi.fn() }, shell: { openExternal: vi.fn() },
}));
vi.mock('./window.ts', () => ({ createWindowController: () => ({ ensure: () => state.create(), focus: vi.fn() }) }));
vi.mock('./logger.ts', () => ({ createLogger: () => vi.fn() }));

beforeEach(() => { vi.resetModules(); state.order.length = 0; state.app.removeAllListeners(); state.create.mockClear(); state.handle.mockClear(); state.spawn.mockClear(); state.locked = true; state.safeStorageAvailable = true; state.secretsDirExists = false; state.secretsDirIsLink = false; state.secretsDirIsReparse = false; state.aclDenied = false; state.ready = Promise.resolve(); });

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
  await vi.waitFor(() => expect(state.create).toHaveBeenCalledOnce());
  expect(state.order).toEqual(['mkdir', 'set-path', 'lock', 'privileged', 'ready', 'mkdir-secrets', 'handler']);
  expect(state.create).toHaveBeenCalledOnce();
});

it('exits before installing handlers or creating a window when safeStorage is unavailable', async () => {
  state.safeStorageAvailable = false;
  const electron = await import('electron');
  const fsPromises = await import('node:fs/promises');
  await import('./index.ts');
  await state.ready;
  await Promise.resolve();
  expect(electron.protocol.handle).not.toHaveBeenCalled();
  expect(electron.ipcMain.handle).not.toHaveBeenCalled();
  expect(electron.session.defaultSession.webRequest.onBeforeRequest).not.toHaveBeenCalled();
  expect(electron.session.defaultSession.setPermissionRequestHandler).not.toHaveBeenCalled();
  expect(fsPromises.lstat).not.toHaveBeenCalled();
  expect(fsPromises.mkdir).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
  expect(electron.app.exit).toHaveBeenCalledWith(1);
});

it('refuses a reparse-point secrets directory before ACL commands, handlers, or window setup', async () => {
  state.secretsDirExists = true;
  state.secretsDirIsLink = true;
  const electron = await import('electron');
  await import('./index.ts');
  await state.ready;
  await vi.waitFor(() => expect(electron.app.exit).toHaveBeenCalledWith(1));
  expect(state.spawn.mock.calls.map(([command]) => command)).toEqual(['fsutil.exe']);
  expect(electron.protocol.handle).not.toHaveBeenCalled();
  expect(electron.ipcMain.handle).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it('refuses a non-symbolic Windows reparse tag after read-only detection and before ACL or app setup', async () => {
  state.secretsDirExists = true;
  state.secretsDirIsReparse = true;
  const electron = await import('electron');
  await import('./index.ts');
  await state.ready;
  await vi.waitFor(() => expect(electron.app.exit).toHaveBeenCalledWith(1));
  expect(state.spawn.mock.calls.map(([command]) => command)).toEqual(['fsutil.exe']);
  expect(electron.protocol.handle).not.toHaveBeenCalled();
  expect(electron.ipcMain.handle).not.toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it('does not continue startup after final ACL replacement fails behind the verified per-file ReadData barrier', async () => {
  process.env.OI_TEST_FAIL_ACL_STEP = 'final-acl';
  const electron = await import('electron');
  const fsPromises = await import('node:fs/promises');
  vi.mocked(fsPromises.readdir).mockResolvedValueOnce([{ name: 'probe.secret', isSymbolicLink: () => false, isDirectory: () => false }] as never);
  try {
    await import('./index.ts');
    await state.ready;
    await vi.waitFor(() => expect(electron.app.exit).toHaveBeenCalledWith(1));
    expect(state.spawn.mock.calls[0]?.[0]).toBe('fsutil.exe');
    expect(state.spawn.mock.calls.some(([command, args]) => command === 'powershell.exe' && args?.[3]?.includes("$mode = 'barrier'") && args?.[3]?.includes('FileSystemRights]::ReadData'))).toBe(true);
    expect(state.spawn.mock.calls.some(([command, args]) => command === 'icacls.exe' && args?.includes('/deny'))).toBe(false);
    expect(electron.protocol.handle).not.toHaveBeenCalled();
    expect(electron.ipcMain.handle).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  } finally {
    delete process.env.OI_TEST_FAIL_ACL_STEP;
  }
});
