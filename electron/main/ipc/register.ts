import { IpcError, isIpcErrorCode, type IpcEnvelope } from '../../shared/ipc-contract.ts';
import { APP_ORIGIN } from '../app-origin.ts';
import { InvalidArgumentError } from './validate.ts';

/** The part of Electron's `ipcMain` that is used. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: SenderEvent, ...raw: unknown[]) => Promise<IpcEnvelope>): void;
}

/**
 * The part of an invoke event that identifies who sent it. The frame is all that is checked: the app has one window
 * (Task 4 guarantees it), so a frame at the app origin can only be that window's.
 */
export interface SenderEvent {
  senderFrame: { url: string; parent: unknown } | null;
}

export interface RegisterDeps {
  ipcMain: IpcMainLike;
  /** Receives a short code only: no message, stack or path. */
  log(code: string): void;
}

/**
 * True for the main frame of a page served from the app origin. The parts of the URL are compared one by one rather
 * than its `origin`, because the origin of `blob:https://localhost/x` is the app origin too. A subframe, any other
 * scheme, host or port, user information and a vanished frame are refused.
 */
export function isTrustedSender(event: SenderEvent): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame.parent !== null) return false;
  try {
    const expected = new URL(APP_ORIGIN);
    const url = new URL(frame.url);
    return url.protocol === expected.protocol && url.host === expected.host && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * Answers one request channel. The sender is checked first, the arguments second, and only then does the handler run.
 * Whatever goes wrong, the renderer is told one of the closed error codes and nothing else.
 */
export function registerHandler<A extends unknown[], R>(
  deps: RegisterDeps,
  channel: string,
  validate: (raw: unknown[]) => A,
  handler: (...args: A) => Promise<R>,
): void {
  deps.ipcMain.handle(channel, async (event, ...raw): Promise<IpcEnvelope> => {
    try {
      return await answer(deps, channel, validate, handler, event, raw);
    } catch {
      // Reading the sender, the logger or the reply itself failed. A thrown error would reach the renderer with its
      // message, so every such failure is answered with the closed code instead.
      return { ok: false, code: 'internal' };
    }
  });
}

async function answer<A extends unknown[], R>(
  deps: RegisterDeps,
  channel: string,
  validate: (raw: unknown[]) => A,
  handler: (...args: A) => Promise<R>,
  event: SenderEvent,
  raw: unknown[],
): Promise<IpcEnvelope> {
  if (!isTrustedSender(event)) {
    deps.log(`${channel} untrusted-sender`);
    return { ok: false, code: 'untrusted-sender' };
  }
  let args: A;
  try {
    args = validate(raw);
  } catch (error) {
    if (error instanceof InvalidArgumentError) return { ok: false, code: 'invalid-argument' };
    deps.log(`${channel} internal`);
    return { ok: false, code: 'internal' };
  }
  try {
    return { ok: true, value: await handler(...args) };
  } catch (error) {
    const code = error instanceof IpcError && isIpcErrorCode(error.code) ? error.code : 'internal';
    deps.log(`${channel} ${code}`);
    return { ok: false, code };
  }
}
