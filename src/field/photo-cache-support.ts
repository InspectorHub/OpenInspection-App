import type { PhotoSize } from '@inspectorhub/field-ui';
import { MAX_MEDIA_BYTES } from '../media/media-types';

/** The limits, the shapes and the byte checks of the photo cache (`photo-cache.ts`). */

export type { PhotoSize };

/** The width asked of the server per size; `original` sends none and gets the stored bytes. */
export const PHOTO_WIDTHS = { thumb: 480, view: 1600 } as const;

export interface PhotoCacheLimits {
  /** All copies together; past it the least recently used go down to 80% of it. */
  maxBytes: number;
  /** The same by count: on a desktop every file counts toward its media-file cap. */
  maxEntries: number;
  /** One copy; a bigger answer is not stored. Never above the media cap: the desktop file host refuses a bigger photo. */
  maxFileBytes: number;
  concurrency: number;
  /** Remembered after a 403 or 404. */
  notFoundMs: number;
  /** Remembered after a 5xx or 429 (the server's `Retry-After` wins, up to ten minutes). */
  serverErrorMs: number;
  /** Remembered after a failure to reach the server, or a refusal the person must fix (sign in, update). */
  problemMs: number;
  /** Remembered after something threw (a full disk, a refused write): longer, so one bad photo is not re-downloaded on every render. */
  failureMs: number;
}

export const DEFAULT_PHOTO_CACHE_LIMITS: PhotoCacheLimits = {
  maxBytes: 256 * 1024 * 1024,
  maxEntries: 2000,
  maxFileBytes: MAX_MEDIA_BYTES,
  concurrency: 3,
  notFoundMs: 10 * 60_000,
  serverErrorMs: 60_000,
  problemMs: 30_000,
  failureMs: 5 * 60_000,
};

export interface LocalPhotoCopy {
  bytes: Uint8Array;
  contentType: string;
}

/**
 * Reads the device copy of an uploaded photo. `open` is optional: it looks the inspection's rows up once and returns a
 * reader for many keys, so adopting a whole inspection is not one database scan per photo.
 */
export interface LocalCopyReader {
  (inspectionId: string, key: string): Promise<LocalPhotoCopy | null>;
  open?(inspectionId: string): Promise<(key: string) => Promise<LocalPhotoCopy | null>>;
}

export type Kind = 'jpg' | 'png' | 'webp';
export const TYPE_OF: Record<Kind, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
/** What the bytes are, by their first bytes; the only formats the web view is asked to show. */
export function sniff(b: Uint8Array): Kind | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return 'png';
  const at = (offset: number, text: string): boolean => [...text].every((c, i) => b[offset + i] === c.charCodeAt(0));
  return at(0, 'RIFF') && at(8, 'WEBP') ? 'webp' : null;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((v) => v.toString(16).padStart(2, '0')).join('');
}

