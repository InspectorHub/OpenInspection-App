/** A valid 24 by 24 baseline JPEG of 697 bytes. The engine's photo upload accepts image/jpeg up to 10 MiB. */
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAYABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDlorb2q5Fbe1W4rb2q5Fbe1dk65OFxBUitvaiteK29qK5ZV9T6CliPdCK29quRW3tRRXJObPhMLORcitvaiiiuSU3c+hpTlyn/2Q==';

let cached: Uint8Array<ArrayBuffer> | null = null;

/** The decoded image. A fresh copy each call, so a caller can never change the constant. */
export function tinyJpegBytes(): Uint8Array<ArrayBuffer> {
  cached ??= Uint8Array.from(atob(TINY_JPEG_BASE64), (char) => char.charCodeAt(0));
  return cached.slice();
}

/**
 * The image followed by filler after its end marker, so a transfer takes long enough to interrupt by hand.
 * Decoders stop at the end marker, so the result is still a valid JPEG; it must stay under the 10 MiB ceiling.
 */
export function paddedJpegBytes(totalBytes: number): Uint8Array<ArrayBuffer> {
  const image = tinyJpegBytes();
  const out = new Uint8Array(Math.max(totalBytes, image.length));
  out.set(image, 0);
  return out;
}
