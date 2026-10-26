import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { BRIDGE_METHODS, CHANNELS, EVENT_CHANNELS, type BridgeNamespace, type DesktopBridge } from '../shared/ipc-contract.ts';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, on: electron.on, removeListener: electron.removeListener },
}));

async function exposed(): Promise<Record<string, unknown>> {
  vi.resetModules();
  electron.exposeInMainWorld.mockClear();
  await import('./index.ts');
  expect(electron.exposeInMainWorld).toHaveBeenCalledTimes(1);
  const [name, api] = electron.exposeInMainWorld.mock.calls[0] as [string, Record<string, unknown>];
  expect(name).toBe('oiDesktop');
  return api;
}

const ns = (api: Record<string, unknown>, name: string) => api[name] as Record<string, (...args: unknown[]) => unknown>;

describe('the preload script', () => {
  beforeEach(() => {
    electron.invoke.mockReset();
    electron.on.mockReset();
    electron.removeListener.mockReset();
  });

  it('calls exposeInMainWorld once, in the source and at run time', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source.match(/exposeInMainWorld\(/g)).toHaveLength(1);
    expect(source).toContain("exposeInMainWorld('oiDesktop'");
  });

  it('exposes exactly the keys of DesktopBridge (the list is held to the type in both directions below)', async () => {
    const api = await exposed();
    expect(Object.keys(api).sort()).toEqual(['apiVersion', ...Object.keys(BRIDGE_METHODS)].sort());
    expect(api.apiVersion).toBe(1);
    for (const [name, methods] of Object.entries(BRIDGE_METHODS)) {
      expect(Object.keys(ns(api, name)).sort(), name).toEqual([...methods].sort());
    }
  });

  it('lists in BRIDGE_METHODS every method of DesktopBridge and no other', () => {
    type Listed<N extends BridgeNamespace> = (typeof BRIDGE_METHODS)[N][number];
    type Unlisted = { [N in BridgeNamespace]: Exclude<keyof DesktopBridge[N], Listed<N>> }[BridgeNamespace];
    expectTypeOf<Unlisted>().toEqualTypeOf<never>();
  });

  it('exposes only functions, plain data and namespaces: no ipcRenderer, no event object', async () => {
    const api = await exposed();
    const visit = (value: unknown, path: string): void => {
      if (typeof value === 'function' || typeof value === 'number') return;
      expect(typeof value, path).toBe('object');
      for (const [key, inner] of Object.entries(value as object)) {
        expect(['invoke', 'on', 'send', 'removeListener', 'sendSync', 'postMessage'], `${path}.${key}`).not.toContain(key);
        visit(inner, `${path}.${key}`);
      }
    };
    visit(api, 'oiDesktop');
  });

  it('media has the single method decodeHeic and nothing that names an executable', async () => {
    const api = await exposed();
    expect(Object.keys(ns(api, 'media'))).toEqual(['decodeHeic']);
  });

  it('delivers an event listener the payload only, never the event', async () => {
    const api = await exposed();
    const listener = vi.fn();
    const stop = ns(api, 'uploader').onEvent!(listener) as () => void;
    expect(electron.on).toHaveBeenCalledWith(EVENT_CHANNELS.uploaderEvent, expect.any(Function));
    const wrapped = electron.on.mock.calls[0]![1] as (event: unknown, payload: unknown) => void;
    wrapped({ sender: 'ipc-renderer-internals' }, { name: 'completed', id: 'x' });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]).toEqual([{ name: 'completed', id: 'x' }]);
    stop();
    expect(electron.removeListener).toHaveBeenCalledWith(EVENT_CHANNELS.uploaderEvent, wrapped);
  });

  it.each([
    ['auth', 'onCallback', EVENT_CHANNELS.authCallback, 'io.inspectorhub.app:/oauth/callback?code=1'],
    ['app', 'onActiveChange', EVENT_CHANNELS.activeChange, true],
    ['updater', 'onState', EVENT_CHANNELS.updaterState, { kind: 'idle' }],
  ])('%s.%s listens on its own event channel', async (name, method, channel, payload) => {
    const api = await exposed();
    const listener = vi.fn();
    ns(api, name)[method]!(listener);
    const wrapped = electron.on.mock.calls[0]![1] as (event: unknown, value: unknown) => void;
    expect(electron.on.mock.calls[0]![0]).toBe(channel);
    wrapped({}, payload);
    expect(listener.mock.calls[0]).toEqual([payload]);
  });

  it('unwraps a successful reply', async () => {
    const api = await exposed();
    electron.invoke.mockResolvedValue({ ok: true, value: 5 });
    await expect(ns(api, 'kv').get!('k')).resolves.toBe(5);
    expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.kv.get, 'k');
  });

  it.each([
    ['a coded failure', { ok: false, code: 'untrusted-sender' }, 'untrusted-sender'],
    ['an unknown code', { ok: false, code: 'EPERM C:\\Users\\bob' }, 'internal'],
    ['a malformed reply', 'oops', 'internal'],
  ])('turns %s into an error whose message is a closed code', async (_name, reply, message) => {
    const api = await exposed();
    electron.invoke.mockResolvedValue(reply);
    await expect(ns(api, 'kv').get!('k')).rejects.toThrow(new RegExp(`^${message}$`));
  });

  it('forwards the arguments exactly: an omitted optional is not sent as undefined', async () => {
    const api = await exposed();
    electron.invoke.mockResolvedValue({ ok: true, value: [] });
    await ns(api, 'db').query!('SELECT 1');
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.db.query, 'SELECT 1');
    await ns(api, 'db').query!('SELECT ?', [1]);
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.db.query, 'SELECT ?', [1]);
  });

  it('files.stream is a namespace over three channels', async () => {
    const api = await exposed();
    electron.invoke.mockResolvedValue({ ok: true, value: { handle: 'h' } });
    const stream = ns(api, 'files').stream as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    await stream.open!('media', 'a.jpg');
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.files.streamOpen, 'media', 'a.jpg');
    await stream.finish!('h', 'commit');
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.files.streamFinish, 'h', 'commit');
  });

  it('checks a decode reply again on the renderer side', async () => {
    const api = await exposed();
    const request = { bytes: new ArrayBuffer(8), maxLongEdge: 2560 };
    electron.invoke.mockResolvedValue({ ok: true, value: { ok: false, code: 'CODEC_MISSING' } });
    await expect(ns(api, 'media').decodeHeic!(request)).resolves.toEqual({ ok: false, code: 'CODEC_MISSING' });
    expect(electron.invoke).toHaveBeenLastCalledWith(CHANNELS.media.decodeHeic, request);
    electron.invoke.mockResolvedValue({ ok: true, value: { ok: false, code: 'DISK_ON_FIRE' } });
    await expect(ns(api, 'media').decodeHeic!(request)).rejects.toThrow(/^internal$/);
  });
});
