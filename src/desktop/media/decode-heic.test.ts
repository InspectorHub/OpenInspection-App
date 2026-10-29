import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridge, DecodeHeicRequest, DecodeHeicReply } from '../../../electron/shared/ipc-contract';
import { createDesktopDecodeImage, HEIC_INSTALL_LINKS } from './decode-heic';

const heicBytes = Uint8Array.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
const file = (bytes: Uint8Array, type = 'image/heic'): Blob => new Blob([bytes.slice().buffer as ArrayBuffer], { type });
type DecodeHeic = DesktopBridge['media']['decodeHeic'];
const bridgeFor = (decodeHeic: DecodeHeic): Pick<DesktopBridge, 'media'> => ({ media: { decodeHeic } });
const decodeReply = (reply: DecodeHeicReply): DecodeHeic => vi.fn(async (_request: DecodeHeicRequest) => reply);

afterEach(() => vi.unstubAllGlobals());

describe('createDesktopDecodeImage', () => {
  it('declines non-HEIF input without invoking the system bridge', async () => {
    const decodeHeic = decodeReply({ ok: true, jpeg: new Uint8Array(3) });
    const decode = createDesktopDecodeImage(bridgeFor(decodeHeic));

    await expect(decode(file(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) , { maxLongEdge: 2560 })).resolves.toBeNull();
    expect(decodeHeic).not.toHaveBeenCalled();
  });

  it('hands HEIF bytes to the bridge and returns a JPEG blob', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);
    const decodeHeic = decodeReply({ ok: true, jpeg });
    const decode = createDesktopDecodeImage(bridgeFor(decodeHeic));

    const result = await decode(file(heicBytes), { maxLongEdge: 1920 });
    expect(decodeHeic).toHaveBeenCalledWith({ bytes: heicBytes.buffer as ArrayBuffer, maxLongEdge: 1920 });
    expect(result?.blob.type).toBe('image/jpeg');
    expect([...new Uint8Array(await result!.blob.arrayBuffer())]).toEqual([...jpeg]);
  });

  it('requests full-size decoding with the keep-original byte ceiling', async () => {
    const decodeHeic = decodeReply({ ok: true, jpeg: new Uint8Array(3) });
    const decode = createDesktopDecodeImage(bridgeFor(decodeHeic));

    await decode(file(heicBytes), { keepOriginal: { maxBytes: 10 * 1024 * 1024 } });
    expect(decodeHeic).toHaveBeenCalledWith({ bytes: heicBytes.buffer as ArrayBuffer, maxLongEdge: Infinity, keepOriginal: { maxBytes: 10 * 1024 * 1024 } });
  });

  it('explains both Windows extensions and the JPEG alternative when the codec is missing', async () => {
    const decodeHeic = decodeReply({ ok: false, code: 'CODEC_MISSING' });
    const decode = createDesktopDecodeImage(bridgeFor(decodeHeic));

    await expect(decode(file(heicBytes), { maxLongEdge: 2560 })).rejects.toMatchObject({
      name: 'DecodeImageError',
      code: 'UNSUPPORTED',
      message: expect.stringContaining('HEIF Image Extensions'),
    });
    try {
      await decode(file(heicBytes), { maxLongEdge: 2560 });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('HEVC Video Extensions');
      expect(message).toContain(HEIC_INSTALL_LINKS.heifExtension);
      expect(message).toContain(HEIC_INSTALL_LINKS.hevcExtension);
      expect(message).toContain('JPEG');
    }
  });

  it('reports a missing helper without directing the user to install codecs', async () => {
    const decodeHeic = decodeReply({ ok: false, code: 'HELPER_MISSING' });
    const decode = createDesktopDecodeImage(bridgeFor(decodeHeic));

    await expect(decode(file(heicBytes), { maxLongEdge: 2560 })).rejects.toMatchObject({
      name: 'DecodeImageError',
      code: 'UNSUPPORTED',
    });
    try {
      await decode(file(heicBytes), { maxLongEdge: 2560 });
    } catch (error) {
      expect((error as Error).message).not.toContain(HEIC_INSTALL_LINKS.heifExtension);
      expect((error as Error).message).not.toContain(HEIC_INSTALL_LINKS.hevcExtension);
    }
  });

  it.each([
    ['CORRUPT', 'CORRUPT'],
    ['TOO_LARGE_PIXELS', 'TOO_LARGE_PIXELS'],
  ] as const)('preserves the %s failure code', async (replyCode, expectedCode) => {
    const decodeHeic = decodeReply({ ok: false, code: replyCode });
    const decode = createDesktopDecodeImage(bridgeFor(decodeHeic));

    await expect(decode(file(heicBytes), { maxLongEdge: 2560 })).rejects.toMatchObject({ name: 'DecodeImageError', code: expectedCode });
  });

  it('does not invoke the bridge when input exceeds the decoder ceiling', async () => {
    const decodeHeic = decodeReply({ ok: true, jpeg: new Uint8Array(3) });
    const decode = createDesktopDecodeImage(bridgeFor(decodeHeic));
    const large = new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]);

    await expect(decode(large, { maxLongEdge: 2560 })).rejects.toMatchObject({ name: 'DecodeImageError' });
    expect(decodeHeic).not.toHaveBeenCalled();
  });
});
