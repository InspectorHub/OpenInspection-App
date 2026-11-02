/**
 * Content types the store accepts and the file extension each is stored under. The extension comes from
 * these tables only, never from a file name. Photos are exactly the set the engine's signed photo upload accepts
 * (`image/jpeg`, `image/png`, `image/heic`); clips are the two of the engine's video upload types the app records
 * (`video/mp4`, and `video/quicktime`, which the engine stores as `.mov`). A type the server would refuse is not
 * stored, so nothing can sit on the device waiting for an upload that can never succeed.
 *
 * This module is pure data and byte checks: the desktop main process imports it, so it must not import anything
 * that reaches the DOM, React or a native plugin.
 */
export const PHOTO_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
} as const;

export const VIDEO_CONTENT_TYPES = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
} as const;

export const MEDIA_CONTENT_TYPES = { ...PHOTO_CONTENT_TYPES, ...VIDEO_CONTENT_TYPES } as const;

export type MediaContentType = keyof typeof MEDIA_CONTENT_TYPES;
export type VideoContentType = keyof typeof VIDEO_CONTENT_TYPES;

/** The engine's photo ceiling (10 MiB), checked here so an oversized photo is refused before it is written. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
/**
 * The engine's clip ceiling (`MAX_VIDEO_BYTES` of its video upload route, 200 MiB). A constant: nothing the user or a
 * server sends changes it, and it is the only REAL bound on a clip (the duration below is a claim by the caller).
 * It must stay aligned with the deployed engine plan: the engine buffers the whole file in memory (its video upload
 * parses the body and reads it into an array buffer), so the figure has to fit the Worker memory limit (128 MB) and
 * the request body limit of the plan the engine runs on (100 MB on the Free and Pro plans). If the deployed plan
 * cannot take this size, lower the value here together with the engine's own.
 */
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
/**
 * The longest single clip, the same 30 seconds the engine asks Stream to enforce and the web capture sheet shows. It is
 * checked only against the duration the caller declares in `meta.durationSec`, which is a claim and not a measurement:
 * the size cap is the only bound that holds for whatever the file really contains.
 */
export const VIDEO_MAX_SECONDS = 30;

/**
 * The only host a Stream direct-upload url may name. It is the host Cloudflare documents for direct creator uploads
 * (`https://upload.videodelivery.net/<uid>`, Cloudflare Stream docs, "Direct creator uploads"). The engine reaches
 * it through the Stream binding, which hands back whatever Cloudflare answered, so the app does not take the host
 * from the answer: it compares it to this constant, exactly, and also requires the path to be the uid of the same
 * answer's ref. A different Cloudflare host (for example a customer subdomain) is refused until it is added here on
 * purpose. The shape of the direct-upload url (host and single-segment path) is taken from the Cloudflare documentation
 * only; it has not been observed against a live Stream account. It lives here, not in `video.ts`, because the desktop
 * main process also needs it to tell a third-party upload (no client headers) from an engine upload.
 */
export const STREAM_UPLOAD_HOST = 'upload.videodelivery.net';

/** True for the Stream direct-upload host over https on the default port: the one destination that gets no client headers. */
export function isStreamUploadUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname === STREAM_UPLOAD_HOST && url.port === '';
}

/** The most bytes of one HEIC file handed to the system decoder. */
export const MAX_DECODE_INPUT_BYTES = 50 * 1024 * 1024;
/** The most pixels one decoded image may have, read from its header before any decoding starts. */
export const MAX_DECODE_PIXELS = 64_000_000;
/** How long one decode may run before it is stopped. */
export const DECODE_TIMEOUT_MS = 30_000;

/** The `ftyp` brands of a HEIF still image. `avif` is deliberately absent: the renderer decodes AVIF itself. */
export const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'] as const;

const AVIF_BRANDS: readonly string[] = ['avif', 'avis'];

const brandAt = (bytes: Uint8Array, offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));

/**
 * What the leading bytes of a file really are, whatever its name or declared type says: `jpeg`, `png`, `heic` (an ISO
 * base media file whose major or compatible brand is a HEIF brand and none is an AVIF brand) or null.
 */
export function sniffMediaKind(bytes: Uint8Array): 'jpeg' | 'png' | 'heic' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return 'png';
  if (brandAt(bytes, 4) !== 'ftyp') return null;
  const boxSize = ((bytes[0] ?? 0) * 2 ** 24) + ((bytes[1] ?? 0) << 16) + ((bytes[2] ?? 0) << 8) + (bytes[3] ?? 0);
  if (boxSize < 16) return null;
  const end = Math.min(bytes.length, boxSize);
  const brands = [brandAt(bytes, 8)];
  for (let offset = 16; offset + 4 <= end; offset += 4) brands.push(brandAt(bytes, offset));
  if (brands.some((brand) => AVIF_BRANDS.includes(brand))) return null;
  return brands.some((brand) => (HEIF_BRANDS as readonly string[]).includes(brand)) ? 'heic' : null;
}
