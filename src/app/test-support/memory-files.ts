import type { Files } from '../../platform/files';

export interface MemoryFiles extends Files {
  /** Paths currently present. */
  paths(): string[];
  /** The bytes stored at `path`, or undefined. */
  bytes(path: string): Uint8Array | undefined;
  /** Every path `remove` was asked to delete, in order, whether or not it succeeded. */
  removeCalls(): string[];
  /** Every path `write` was asked to write, in order, whether or not it succeeded. */
  writeCalls(): string[];
  /** Makes `remove` reject for this path. */
  failRemoveFor(path: string): void;
  /** Makes every later `write` reject, as a full disk does; nothing is stored. */
  failWrites(): void;
  /** Makes `read` reject for this path. */
  failReadFor(path: string): void;
  /** Every path any method was asked about, in order. */
  accessed(): string[];
  /** Makes `exists` reject for this path with an error that is not a not-found answer (a transient stat failure). */
  failExistsFor(path: string): void;
  /** Sets the modification time `list` reports for this path (files default to the time they were written). */
  setMtime(path: string, mtimeMs: number | null): void;
  /** Makes `size` report this many bytes for the path, whatever is stored (a file that grew behind the app's back). */
  setSize(path: string, bytes: number | null): void;
}

/** An in-memory `Files` for tests. */
export function createMemoryFiles(initial: Record<string, Uint8Array> = {}): MemoryFiles {
  const store = new Map<string, Uint8Array>(Object.entries(initial));
  const removed: string[] = [];
  const written: string[] = [];
  const failing = new Set<string>();
  const failingReads = new Set<string>();
  const touched: string[] = [];
  let writesFail = false;
  const failingExists = new Set<string>();
  const mtimes = new Map<string, number | null>();
  const sizes = new Map<string, number | null>();
  return {
    write: (path, data) => {
      touched.push(path);
      written.push(path);
      if (writesFail) return Promise.reject(new Error('No space left on device'));
      store.set(path, data);
      mtimes.set(path, Date.now());
      return Promise.resolve(`file:///${path}`);
    },
    writeStream: async (path, chunks) => {
      touched.push(path);
      written.push(path);
      if (writesFail) throw new Error('No space left on device');
      const parts: Uint8Array[] = [];
      for await (const chunk of chunks) parts.push(chunk);
      const data = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let at = 0;
      for (const part of parts) {
        data.set(part, at);
        at += part.length;
      }
      store.set(path, data);
      mtimes.set(path, Date.now());
      return `file:///${path}`;
    },
    size: (path) => {
      touched.push(path);
      const stored = store.get(path);
      if (stored === undefined) return Promise.reject(new Error('File does not exist'));
      return Promise.resolve(sizes.has(path) ? (sizes.get(path) ?? null) : stored.length);
    },
    read: (path) => {
      touched.push(path);
      if (failingReads.has(path)) return Promise.reject(new Error('Unable to read file'));
      const data = store.get(path);
      return data ? Promise.resolve(data) : Promise.reject(new Error('File does not exist'));
    },
    remove: (path) => {
      touched.push(path);
      removed.push(path);
      if (failing.has(path)) return Promise.reject(new Error('Unable to delete file'));
      if (!store.delete(path)) return Promise.reject(new Error('File does not exist'));
      return Promise.resolve();
    },
    exists: (path) => {
      touched.push(path);
      if (failingExists.has(path)) return Promise.reject(new Error('I/O error while reading file metadata'));
      return Promise.resolve(store.has(path));
    },
    list: (directoryPath) => {
      touched.push(directoryPath);
      const prefix = `${directoryPath}/`;
      return Promise.resolve(
        [...store.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map((key) => ({ name: key.slice(prefix.length), mtimeMs: mtimes.get(key) ?? null })),
      );
    },
    fileUri: (path) => {
      touched.push(path);
      return Promise.resolve(`file:///${path}`);
    },
    displayUrl: (path) => {
      touched.push(path);
      return Promise.resolve(`https://localhost/_capacitor_file_/${path}`);
    },
    accessed: () => [...touched],
    writeCacheChunks: (path) => Promise.resolve(`file:///cache/${path}`),
    removeCache: () => Promise.resolve(),
    paths: () => [...store.keys()],
    bytes: (path) => store.get(path),
    removeCalls: () => [...removed],
    writeCalls: () => [...written],
    failRemoveFor: (path) => {
      failing.add(path);
    },
    failWrites: () => {
      writesFail = true;
    },
    failReadFor: (path) => {
      failingReads.add(path);
    },
    failExistsFor: (path) => {
      failingExists.add(path);
    },
    setMtime: (path, mtimeMs) => {
      mtimes.set(path, mtimeMs);
    },
    setSize: (path, bytes) => {
      sizes.set(path, bytes);
    },
  };
}
