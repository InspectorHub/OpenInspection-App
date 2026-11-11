/** A Blob whose reads reject a set number of times before they work, with a count of the attempts made. */
export interface FlakyBlob {
  blob: Blob;
  /** Reads attempted on the whole blob (`arrayBuffer`). */
  wholeReads(): number;
  /** Reads attempted on the leading slice taken for type sniffing. */
  sliceReads(): number;
}

export function flakyBlob(source: Blob, failures: { whole?: number; slice?: number }): FlakyBlob {
  let whole = 0;
  let slices = 0;
  let wholeLeft = failures.whole ?? 0;
  let sliceLeft = failures.slice ?? 0;
  const blob = source.slice(0, source.size, source.type);
  Object.defineProperty(blob, 'arrayBuffer', {
    value: (): Promise<ArrayBuffer> => {
      whole += 1;
      if (wholeLeft > 0) {
        wholeLeft -= 1;
        return Promise.reject(new Error('transient read failure'));
      }
      return source.arrayBuffer();
    },
  });
  Object.defineProperty(blob, 'slice', {
    value: (start?: number, end?: number, type?: string): Blob => {
      const part = source.slice(start, end, type);
      Object.defineProperty(part, 'arrayBuffer', {
        value: (): Promise<ArrayBuffer> => {
          slices += 1;
          if (sliceLeft > 0) {
            sliceLeft -= 1;
            return Promise.reject(new Error('transient read failure'));
          }
          return Blob.prototype.arrayBuffer.call(source.slice(start, end, type));
        },
      });
      return part;
    },
  });
  return { blob, wholeReads: () => whole, sliceReads: () => slices };
}
