import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE_METHODS, CHANNELS } from '../shared/ipc-contract.ts';

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

async function exposed(): Promise<Record<string, unknown>> {
  vi.resetModules();
  electron.exposeInMainWorld.mockClear();
  await import('./index.ts');
  return electron.exposeInMainWorld.mock.calls[0]![1] as Record<string, unknown>;
}

const MIN_BYTES = new Uint8Array(1);
const INVOKES: [path: string, args: unknown[], channel: string][] = [
  ['db.open', [], CHANNELS.db.open],
  ['db.execute', ['s'], CHANNELS.db.execute],
  ['db.query', ['s'], CHANNELS.db.query],
  ['db.run', ['s'], CHANNELS.db.run],
  ['db.begin', [], CHANNELS.db.begin],
  ['db.commit', [], CHANNELS.db.commit],
  ['db.rollback', [], CHANNELS.db.rollback],
  ['db.inTransaction', [], CHANNELS.db.inTransaction],
  ['db.close', [], CHANNELS.db.close],
  ['db.setAsideUnreadable', [], CHANNELS.db.setAsideUnreadable],
  ['secrets.get', ['k'], CHANNELS.secrets.get],
  ['secrets.set', ['k', 'v'], CHANNELS.secrets.set],
  ['secrets.remove', ['k'], CHANNELS.secrets.remove],
  ['kv.get', ['k'], CHANNELS.kv.get],
  ['kv.set', ['k', 'v'], CHANNELS.kv.set],
  ['files.write', ['p', MIN_BYTES], CHANNELS.files.write],
  ['files.size', ['p'], CHANNELS.files.size],
  ['files.read', ['p'], CHANNELS.files.read],
  ['files.remove', ['p'], CHANNELS.files.remove],
  ['files.displayUrl', ['p'], CHANNELS.files.displayUrl],
  ['files.fileUri', ['p'], CHANNELS.files.fileUri],
  ['files.exists', ['p'], CHANNELS.files.exists],
  ['files.list', ['p'], CHANNELS.files.list],
  ['files.removeCache', ['p'], CHANNELS.files.removeCache],
  ['files.listCache', [], CHANNELS.files.listCache],
  ['files.stream.open', ['media', 'p'], CHANNELS.files.streamOpen],
  ['files.stream.append', ['h', MIN_BYTES], CHANNELS.files.streamAppend],
  ['files.stream.finish', ['h', 'commit'], CHANNELS.files.streamFinish],
  ['uploader.start', [{}], CHANNELS.uploader.start],
  ['uploader.remove', ['i'], CHANNELS.uploader.remove],
  ['shell.openExternal', ['https://x'], CHANNELS.shell.openExternal],
  ['shell.openLogs', [], CHANNELS.shell.openLogs],
  ['shell.openDataFolder', [], CHANNELS.shell.openDataFolder],
  ['dialogs.saveExport', ['f', 'n'], CHANNELS.dialogs.saveExport],
  ['updater.state', [], CHANNELS.updater.state],
  ['updater.check', [], CHANNELS.updater.check],
  ['updater.download', [], CHANNELS.updater.download],
  ['updater.installAndRestart', [], CHANNELS.updater.installAndRestart],
  ['media.decodeHeic', [{ bytes: new ArrayBuffer(8), maxLongEdge: 2560 }], CHANNELS.media.decodeHeic],
];
const NOT_INVOKES = ['files.stream', 'uploader.onEvent', 'auth.onCallback', 'app.onActiveChange', 'updater.onState'];

describe('every bridge method reaches its own channel', () => {
  beforeEach(() => {
    electron.invoke.mockReset();
  });

  it('the table covers every method that is not an event subscription, and every request channel once', () => {
    const covered = new Set(INVOKES.map(([path]) => path));
    const all = Object.entries(BRIDGE_METHODS).flatMap(([name, methods]) => methods.map((method) => `${name}.${method}`));
    expect(all.filter((path) => !covered.has(path) && !NOT_INVOKES.includes(path))).toEqual([]);
    expect(INVOKES.map(([, , channel]) => channel).sort()).toEqual(Object.values(CHANNELS).flatMap((group) => Object.values(group)).sort());
  });

  it.each(INVOKES)('%s invokes its own channel', async (path, args, channel) => {
    const api = await exposed();
    electron.invoke.mockResolvedValue({ ok: true, value: null });
    const target = path.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], api) as (...a: unknown[]) => Promise<unknown>;
    await target(...args).catch(() => undefined);
    expect(electron.invoke).toHaveBeenCalledTimes(1);
    expect(electron.invoke.mock.calls[0]![0]).toBe(channel);
  });

  it('turns a rejected invoke into a closed code, whatever text the rejection carries', async () => {
    const api = await exposed();
    electron.invoke.mockRejectedValue(new Error("Error invoking remote method 'kv:get': Error: EPERM C:\\Users\\bob\\kv.json"));
    const kv = api.kv as { get(key: string): Promise<unknown> };
    const error = await kv.get('k').then(
      () => null,
      (reason: Error) => reason,
    );
    expect(error?.message).toBe('internal');
    expect(JSON.stringify([error?.message, error?.stack?.split('\n')[0]])).not.toMatch(/bob|EPERM/);
  });
});
