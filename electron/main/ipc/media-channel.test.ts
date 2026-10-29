import { describe, expect, it, vi } from 'vitest';
import { MAX_DECODE_INPUT_BYTES, MAX_MEDIA_BYTES } from '../../../src/media/media-types.ts';
import { CHANNELS, isDecodeHeicReply, type DecodeHeicReply, type DecodeHeicRequest, type IpcEnvelope } from '../../shared/ipc-contract.ts';
import { registerHandler, type IpcMainLike } from './register.ts';
import { InvalidArgumentError, validators } from './validate.ts';

const TRUSTED = { senderFrame: { url: 'https://localhost/index.html', parent: null } };
const FOREIGN = { senderFrame: { url: 'https://evil.example/', parent: null } };

function setup(runner: (request: DecodeHeicRequest) => Promise<DecodeHeicReply>) {
  const handlers = new Map<string, (event: unknown, ...raw: unknown[]) => Promise<IpcEnvelope>>();
  const ipcMain: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener as never) };
  const log = vi.fn();
  registerHandler(
    { ipcMain, log },
    CHANNELS.media.decodeHeic,
    validators.media.decodeHeic,
    runner,
  );
  const call = (event: unknown, ...raw: unknown[]) => handlers.get(CHANNELS.media.decodeHeic)!(event, ...raw);
  return { call, log };
}

const jpegReply: DecodeHeicReply = { ok: true, jpeg: Uint8Array.of(0xff, 0xd8, 0xff, 0xd9) };
const request = (over: Record<string, unknown> = {}) => ({ bytes: new ArrayBuffer(16), maxLongEdge: 2560, ...over });

describe('the media:decode-heic channel', () => {
  it('rejects a request from an untrusted sender', async () => {
    const runner = vi.fn(async () => jpegReply);
    const { call } = setup(runner);
    expect(await call(FOREIGN, request())).toEqual({ ok: false, code: 'untrusted-sender' });
    expect(runner).not.toHaveBeenCalled();
    expect(await call(TRUSTED, request())).toEqual({ ok: true, value: jpegReply });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('rejects empty bytes and bytes over the input ceiling without calling the runner', async () => {
    const runner = vi.fn(async () => jpegReply);
    const { call } = setup(runner);
    expect(await call(TRUSTED, request({ bytes: new ArrayBuffer(0) }))).toEqual({ ok: false, code: 'invalid-argument' });
    expect(await call(TRUSTED, request({ bytes: new ArrayBuffer(MAX_DECODE_INPUT_BYTES + 1) }))).toEqual({ ok: false, code: 'invalid-argument' });
    expect(runner).not.toHaveBeenCalled();
    expect((await call(TRUSTED, request({ bytes: new ArrayBuffer(MAX_DECODE_INPUT_BYTES) }))).ok).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('rejects a string or a typed-array view where an ArrayBuffer is required', () => {
    expect(() => validators.media.decodeHeic([request({ bytes: 'abc' })])).toThrow(InvalidArgumentError);
    expect(() => validators.media.decodeHeic([request({ bytes: new Uint8Array(8) })])).toThrow(InvalidArgumentError);
    expect(() => validators.media.decodeHeic([request({ bytes: new ArrayBuffer(8) })])).not.toThrow();
  });

  it('rejects unknown keys', () => {
    expect(() => validators.media.decodeHeic([request({ exePath: 'C:\\x.exe' })])).toThrow(InvalidArgumentError);
    expect(() => validators.media.decodeHeic([request({ keepOriginal: { maxBytes: 1024, args: ['-x'] } })])).toThrow(InvalidArgumentError);
    expect(() => validators.media.decodeHeic([request()])).not.toThrow();
  });

  it('rejects an infinite maxLongEdge unless keepOriginal is present', () => {
    expect(() => validators.media.decodeHeic([request({ maxLongEdge: Infinity })])).toThrow(InvalidArgumentError);
    expect(() => validators.media.decodeHeic([request({ maxLongEdge: Infinity, keepOriginal: { maxBytes: MAX_MEDIA_BYTES } })])).not.toThrow();
  });

  it('rejects a non-positive or non-numeric maxLongEdge and a keepOriginal outside (0, MAX_MEDIA_BYTES]', () => {
    for (const maxLongEdge of [0, -1, Number.NaN, '2560']) expect(() => validators.media.decodeHeic([request({ maxLongEdge })])).toThrow(InvalidArgumentError);
    for (const maxBytes of [0, -5, MAX_MEDIA_BYTES + 1, Infinity, '1024']) {
      expect(() => validators.media.decodeHeic([request({ keepOriginal: { maxBytes } })])).toThrow(InvalidArgumentError);
    }
    expect(() => validators.media.decodeHeic([request({ keepOriginal: { maxBytes: MAX_MEDIA_BYTES } })])).not.toThrow();
  });

  it('a runner error carrying a file path reaches the renderer only as a closed code', async () => {
    const { call, log } = setup(async () => {
      throw new Error('spawn C:\\Users\\bob\\AppData\\helper.exe ENOENT');
    });
    const reply = await call(TRUSTED, request());
    expect(reply).toEqual({ ok: false, code: 'internal' });
    expect(JSON.stringify(reply)).not.toMatch(/bob|helper|ENOENT/);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/bob|helper|ENOENT/);
  });

  it('a reply with an unknown code is rejected by the renderer-side check', () => {
    expect(isDecodeHeicReply({ ok: false, code: 'CODEC_MISSING' })).toBe(true);
    expect(isDecodeHeicReply({ ok: false, code: 'DISK_ON_FIRE' })).toBe(false);
    expect(isDecodeHeicReply({ ok: false, code: 'CORRUPT', message: 'C:\\x' })).toBe(false);
    expect(isDecodeHeicReply({ ok: true, jpeg: Uint8Array.of(0xff, 0xd8, 0xff) })).toBe(true);
    expect(isDecodeHeicReply({ ok: true, jpeg: new ArrayBuffer(2) })).toBe(false);
    expect(isDecodeHeicReply({ ok: true, jpeg: 'text' })).toBe(false);
    expect(isDecodeHeicReply(null)).toBe(false);
  });
});
