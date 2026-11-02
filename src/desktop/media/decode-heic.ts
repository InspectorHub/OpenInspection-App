import { DecodeImageError, type DecodeImage } from '@inspectorhub/field-ui';
import type { DesktopBridge, HeicDecodeCode } from '../../../electron/shared/ipc-contract';
import { MAX_DECODE_INPUT_BYTES, sniffMediaKind } from '../../media/media-types';

export const HEIC_INSTALL_LINKS = {
  heifExtension: 'https://apps.microsoft.com/detail/9pmmsr1cgpwg',
  hevcExtension: 'https://apps.microsoft.com/detail/9n4wgh0z6vhq',
} as const;

const codecMissingMessage = `Windows cannot decode this HEIC photo. Install HEIF Image Extensions (${HEIC_INSTALL_LINKS.heifExtension}) and HEVC Video Extensions (${HEIC_INSTALL_LINKS.hevcExtension}), or export the photo from your phone as JPEG and import it again.`;
const helperMissingMessage = 'The Windows image decoder is unavailable. Restart or reinstall the app, or export the photo from your phone as JPEG and import it again.';
const inputTooLargeMessage = `This HEIC file is larger than the ${MAX_DECODE_INPUT_BYTES / (1024 * 1024)} MiB Windows decoding limit.`;

function decodeError(code: HeicDecodeCode): DecodeImageError {
  switch (code) {
    case 'CODEC_MISSING':
      return new DecodeImageError('UNSUPPORTED', codecMissingMessage);
    case 'HELPER_MISSING':
      return new DecodeImageError('UNSUPPORTED', helperMissingMessage);
    case 'TOO_LARGE_PIXELS':
      return new DecodeImageError('TOO_LARGE_PIXELS', 'This HEIC photo has more pixels than Windows can decode.');
    case 'TOO_LARGE_BYTES':
      return new DecodeImageError('UNSUPPORTED', 'The converted HEIC photo is larger than the allowed size limit.');
    case 'CORRUPT':
      return new DecodeImageError('CORRUPT', 'This HEIC photo is damaged or could not be decoded.');
    case 'UNSUPPORTED':
      return new DecodeImageError('UNSUPPORTED', 'This HEIC photo uses an unsupported format.');
    case 'TIMEOUT':
      return new DecodeImageError('UNSUPPORTED', 'Windows took too long to decode this HEIC photo. Try again or export it from your phone as JPEG.');
  }
}

/** Adapts the narrow desktop IPC response to field-ui's optional photo decoder contract. */
export function createDesktopDecodeImage(bridge: { media: { decodeHeic: NonNullable<DesktopBridge['media']['decodeHeic']> } }): DecodeImage {
  return async (file, options) => {
    if (file.size > MAX_DECODE_INPUT_BYTES) throw new DecodeImageError('UNSUPPORTED', inputTooLargeMessage);

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (sniffMediaKind(bytes) !== 'heic') return null;

    const request = {
      bytes: bytes.slice().buffer as ArrayBuffer,
      maxLongEdge: options.keepOriginal ? Infinity : options.maxLongEdge ?? 2560,
      ...(options.keepOriginal === undefined ? {} : { keepOriginal: options.keepOriginal }),
    };
    const reply = await bridge.media.decodeHeic(request);
    if (!reply.ok) throw decodeError(reply.code);
    const jpegBytes = reply.jpeg.slice();
    return { blob: new Blob([jpegBytes.buffer as ArrayBuffer], { type: 'image/jpeg' }) };
  };
}
