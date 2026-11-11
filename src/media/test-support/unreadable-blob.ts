import { jpegBytes } from './fakes';

/**
 * A picked file the system handed over and the browser then cannot read: the size is known, every read rejects.
 * It is a real Blob, so `instanceof` checks and `slice` behave as for any file; only the byte readers fail.
 */
export function unreadableBlob(length = 64, type = 'image/jpeg'): Blob {
  const blob = new Blob([jpegBytes(1, length)], { type });
  const refuse = (): Promise<ArrayBuffer> => Promise.reject(new DOMException('The requested file could not be read', 'NotReadableError'));
  Object.defineProperty(blob, 'arrayBuffer', { value: refuse });
  Object.defineProperty(blob, 'stream', { value: () => { throw new DOMException('The requested file could not be read', 'NotReadableError'); } });
  Object.defineProperty(blob, 'slice', {
    value: (): Blob => {
      const part = new Blob([], { type });
      Object.defineProperty(part, 'arrayBuffer', { value: refuse });
      return part;
    },
  });
  return blob;
}
