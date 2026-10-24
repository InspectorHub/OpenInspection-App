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
  return {
    write: (path, data) => {
      touched.push(path);
      written.push(path);
      if (writesFail) return Promise.reject(new Error('No space left on device'));
      store.set(path, data);
      return Promise.resolve(`file:///${path}`);
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
      return Promise.resolve(store.has(path));
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
  };
}
