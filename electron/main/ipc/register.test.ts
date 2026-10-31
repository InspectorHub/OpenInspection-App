import { describe, expect, it, vi } from 'vitest';
import { IpcError, type IpcEnvelope } from '../../shared/ipc-contract.ts';
import { isTrustedSender, registerHandler, type IpcMainLike } from './register.ts';
import { InvalidArgumentError } from './validate.ts';

const TRUSTED = { senderFrame: { url: 'https://localhost/index.html', parent: null } };

function harness() {
  const handlers = new Map<string, (event: unknown, ...raw: unknown[]) => Promise<IpcEnvelope>>();
  const ipcMain: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener as never) };
  const log = vi.fn();
  const deps = { ipcMain, log };
  const invoke = (event: unknown, ...raw: unknown[]) => handlers.get('db:open')!(event, ...raw);
  return { deps, invoke, log };
}

const oneString = (raw: unknown[]): [string] => {
  if (raw.length !== 1 || typeof raw[0] !== 'string') throw new InvalidArgumentError();
  return [raw[0]];
};

describe('isTrustedSender', () => {
  it.each([
    ['a subframe of the app page', { senderFrame: { url: 'https://localhost/index.html', parent: {} } }],
    ['another origin', { senderFrame: { url: 'https://evil.example/', parent: null } }],
    ['a lookalike host', { senderFrame: { url: 'https://localhost.evil.example/', parent: null } }],
    ['http on localhost', { senderFrame: { url: 'http://localhost/', parent: null } }],
    ['another port', { senderFrame: { url: 'https://localhost:8443/', parent: null } }],
    ['a frame that is gone', { senderFrame: null }],
    ['an unparseable url', { senderFrame: { url: 'not a url', parent: null } }],
    ['a blob url of the app origin', { senderFrame: { url: 'blob:https://localhost/3f2a', parent: null } }],
    ['about:blank', { senderFrame: { url: 'about:blank', parent: null } }],
    ['a data url', { senderFrame: { url: 'data:text/html,hi', parent: null } }],
    ['a file url', { senderFrame: { url: 'file:///C:/index.html', parent: null } }],
    ['userinfo that names the app origin', { senderFrame: { url: 'https://localhost@evil.example/', parent: null } }],
    ['userinfo before the app host', { senderFrame: { url: 'https://user:pw@localhost/', parent: null } }],
  ])('refuses %s', (_name, event) => {
    expect(isTrustedSender(event)).toBe(false);
  });

  it('accepts the main frame of https://localhost (control)', () => {
    expect(isTrustedSender(TRUSTED)).toBe(true);
    expect(isTrustedSender({ senderFrame: { url: 'https://localhost/deep/path?q=1#h', parent: null } })).toBe(true);
  });
});

describe('registerHandler', () => {
  it('uses the real sender check: there is no way to inject another one', async () => {
    const { deps, invoke } = harness();
    registerHandler({ ...deps, isTrustedSender: () => true } as typeof deps, 'db:open', oneString, async (value: string) => value);
    expect(await invoke({ senderFrame: { url: 'https://evil.example/', parent: null } }, 'a')).toEqual({ ok: false, code: 'untrusted-sender' });
  });

  it('answers internal and never runs the handler when reading the sender throws', async () => {
    const { deps, invoke } = harness();
    const handler = vi.fn(async (value: string) => value);
    registerHandler(deps, 'db:open', oneString, handler);
    const disposed = {
      get senderFrame(): never {
        throw new Error('Render frame was disposed C:\\Users\\bob');
      },
    };
    const reply = await invoke(disposed, 'a');
    expect(reply).toEqual({ ok: false, code: 'internal' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('answers internal when the logger itself throws with a path in its message', async () => {
    const { deps, invoke, log } = harness();
    log.mockImplementation(() => {
      throw new Error('EPERM C:\\Users\\bob\\main.log');
    });
    registerHandler(deps, 'db:open', oneString, async (_value: string) => {
      throw new Error('boom');
    });
    const reply = await invoke(TRUSTED, 'a');
    expect(reply).toEqual({ ok: false, code: 'internal' });
    expect(JSON.stringify(reply)).not.toMatch(/bob/);
  });

  it('refuses an untrusted sender and never calls the handler', async () => {
    const { deps, invoke } = harness();
    const handler = vi.fn(async (_value: string) => 1);
    registerHandler(deps, 'db:open', oneString, handler);
    expect(await invoke({ senderFrame: { url: 'https://evil.example/', parent: null } }, 'a')).toEqual({ ok: false, code: 'untrusted-sender' });
    expect(await invoke({ senderFrame: { url: 'https://localhost/', parent: {} } }, 'a')).toEqual({ ok: false, code: 'untrusted-sender' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('delivers a trusted call to the handler (control)', async () => {
    const { deps, invoke } = harness();
    const handler = vi.fn(async (value: string) => value.toUpperCase());
    registerHandler(deps, 'db:open', oneString, handler);
    expect(await invoke(TRUSTED, 'a')).toEqual({ ok: true, value: 'A' });
    expect(handler).toHaveBeenCalledExactlyOnceWith('a');
  });

  it.each([
    ['a missing argument', []],
    ['an extra argument', ['a', 'b']],
    ['a number where a string is required', [1]],
  ])('answers %s with invalid-argument and never calls the handler', async (_name, raw) => {
    const { deps, invoke } = harness();
    const handler = vi.fn(async (_value: string) => 1);
    registerHandler(deps, 'db:open', oneString, handler);
    expect(await invoke(TRUSTED, ...raw)).toEqual({ ok: false, code: 'invalid-argument' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes a closed error code thrown by the handler through, and nothing else', async () => {
    const { deps, invoke } = harness();
    registerHandler(deps, 'db:open', oneString, async (_value) => {
      throw new IpcError('disk-full');
    });
    expect(await invoke(TRUSTED, 'a')).toEqual({ ok: false, code: 'disk-full' });
  });

  it('turns an error that carries a path into internal, with no message, stack or path in the reply or the log', async () => {
    const { deps, invoke, log } = harness();
    registerHandler(deps, 'db:open', oneString, async (_value) => {
      throw new Error('EPERM: open C:\\Users\\bob\\AppData\\Roaming\\InspectorHub\\db\\app.db');
    });
    const reply = await invoke(TRUSTED, 'a');
    expect(reply).toEqual({ ok: false, code: 'internal' });
    expect(JSON.stringify(reply)).not.toMatch(/bob|EPERM|Users/);
    expect(log).toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/bob|EPERM|Users/);
  });

  it('an IpcError built from a code outside the closed set is reported as internal', async () => {
    const { deps, invoke } = harness();
    registerHandler(deps, 'db:open', oneString, async (_value) => {
      const error = new IpcError('not-found');
      Object.assign(error, { code: 'ENOENT C:\\x' });
      throw error;
    });
    expect(await invoke(TRUSTED, 'a')).toEqual({ ok: false, code: 'internal' });
  });
});
