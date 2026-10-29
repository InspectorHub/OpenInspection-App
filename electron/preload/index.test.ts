import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { BRIDGE_METHODS, CHANNELS, EVENT_CHANNELS, type BridgeNamespace, type DesktopBridge } from '../shared/ipc-contract.ts';

const electron = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: electron.exposeInMainWorld },
  ipcRenderer: { invoke: electron.invoke, send: electron.send, on: electron.on, removeListener: electron.removeListener },
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
    electron.send.mockReset();
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
    if (name === 'auth') expect(electron.send).toHaveBeenCalledWith('auth:ready');
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

  describe('byte transfer bounds', () => {
    const MIB = 1024 * 1024;
    const fileChannels = [CHANNELS.files.write, CHANNELS.files.streamAppend];

    async function binaryMethod(channel: string): Promise<(...args: unknown[]) => unknown> {
      const api = await exposed();
      if (channel === CHANNELS.files.write) return ns(api, 'files').write!;
      return (ns(api, 'files').stream as unknown as Record<string, (...args: unknown[]) => unknown>).append!;
    }

    it.each(fileChannels)('%s compacts a nonzero-offset view of a 64 MiB backing before invoke and clone', async (channel) => {
      const method = await binaryMethod(channel);
      electron.invoke.mockResolvedValue({ ok: true, value: undefined });
      const backing = new Uint8Array(64 * MIB);
      backing.set([99, 4, 8, 15, 77], 100);
      const view = backing.subarray(101, 104);
      await method('a', view);
      const sent = electron.invoke.mock.calls[0]![2] as Uint8Array;
      expect(electron.invoke.mock.calls[0]![0]).toBe(channel);
      expect(sent.byteOffset).toBe(0);
      expect(sent.buffer.byteLength).toBe(3);
      expect([...sent]).toEqual([4, 8, 15]);
      expect(sent.buffer).not.toBe(view.buffer);
      const cloned = structuredClone(sent);
      expect(cloned.byteOffset).toBe(0);
      expect(cloned.buffer.byteLength).toBe(3);
      expect([...cloned]).toEqual([4, 8, 15]);
      expect(view.byteOffset).toBe(101);
    });

    it.each(fileChannels)('%s accepts the visible 16 MiB boundary with compact storage', async (channel) => {
      const method = await binaryMethod(channel);
      electron.invoke.mockResolvedValue({ ok: true, value: undefined });
      await method('a', new Uint8Array(16 * MIB));
      const sent = electron.invoke.mock.calls[0]![2] as Uint8Array;
      expect(sent.byteLength).toBe(16 * MIB);
      expect(sent.buffer.byteLength).toBe(16 * MIB);
    });

    it.each(fileChannels)('%s refuses an oversized visible view or wrong binary type without invoke', async (channel) => {
      const method = await binaryMethod(channel);
      electron.invoke.mockResolvedValue({ ok: true, value: undefined });
      for (const value of [new Uint8Array(16 * MIB + 1), new ArrayBuffer(8), [1, 2]]) {
        await expect(method('a', value)).rejects.toThrow(/^invalid-argument$/);
      }
      expect(electron.invoke).not.toHaveBeenCalled();
    });

    it.each(['query', 'run'])('db.%s compacts binary params nested in its params array before invoke', async (method) => {
      const api = await exposed();
      electron.invoke.mockResolvedValue({ ok: true, value: [] });
      const backing = new Uint8Array(64 * MIB);
      backing.set([21, 34, 55], 57);
      const view = backing.subarray(57, 60);
      const params = [null, 'text', 7, view];
      await ns(api, 'db')[method]!('SELECT ?', params);
      const sentParams = electron.invoke.mock.calls[0]![2] as unknown[];
      expect(electron.invoke.mock.calls[0]![0]).toBe(CHANNELS.db[method as 'query' | 'run']);
      expect(sentParams.slice(0, 3)).toEqual([null, 'text', 7]);
      const sent = sentParams[3] as Uint8Array;
      expect(sentParams).not.toBe(params);
      expect(sent.byteOffset).toBe(0);
      expect(sent.buffer.byteLength).toBe(3);
      expect([...sent]).toEqual([21, 34, 55]);
      const cloned = structuredClone(sentParams)[3] as Uint8Array;
      expect(cloned.buffer.byteLength).toBe(3);
      expect([...cloned]).toEqual([21, 34, 55]);
    });

    it.each(['query', 'run'])('db.%s accepts exactly 16 MiB of estimated params payload', async (method) => {
      const api = await exposed();
      electron.invoke.mockResolvedValue({ ok: true, value: [] });
      const strings = new Array<string>(7).fill('x'.repeat(MIB));
      await ns(api, 'db')[method]!('SELECT ?', [...strings, new Uint8Array(2 * MIB)]);
      expect(electron.invoke).toHaveBeenCalledOnce();
    });

    it.each(['query', 'run'])('db.%s refuses aggregate overflow, oversized params and invalid shapes before invoke', async (method) => {
      const api = await exposed();
      electron.invoke.mockResolvedValue({ ok: true, value: [] });
      const strings = new Array<string>(7).fill('x'.repeat(MIB));
      const badParams = [
        [...strings, new Uint8Array(2 * MIB + 1)],
        new Array<string>(8).fill('x'.repeat(MIB)).concat('x'),
        [new Uint8Array(16 * MIB + 1)],
        ['x'.repeat(MIB + 1)],
        new Array<number>(1001).fill(0),
        [[new Uint8Array(1)]],
        [{}], [true], [Infinity], [1, , 3], 'text',
      ];
      for (const params of badParams) {
        await expect(ns(api, 'db')[method]!('SELECT ?', params)).rejects.toThrow(/^invalid-argument$/);
      }
      expect(electron.invoke).not.toHaveBeenCalled();
    });

    it('media.decodeHeic refuses oversized, empty and wrong byte types before invoke', async () => {
      const api = await exposed();
      electron.invoke.mockResolvedValue({ ok: true, value: { ok: false, code: 'CORRUPT' } });
      for (const bytes of [new ArrayBuffer(50 * MIB + 1), new ArrayBuffer(0), new Uint8Array(8), 'bytes', null]) {
        await expect(ns(api, 'media').decodeHeic!({ bytes, maxLongEdge: 2560 })).rejects.toThrow(/^invalid-argument$/);
      }
      expect(electron.invoke).not.toHaveBeenCalled();
    });

    it('media.decodeHeic accepts an ArrayBuffer exactly at 50 MiB', async () => {
      const api = await exposed();
      electron.invoke.mockResolvedValue({ ok: true, value: { ok: false, code: 'CORRUPT' } });
      const request = { bytes: new ArrayBuffer(50 * MIB), maxLongEdge: 2560 };
      await ns(api, 'media').decodeHeic!(request);
      expect(electron.invoke).toHaveBeenCalledWith(CHANNELS.media.decodeHeic, request);
    });
  });
});
