import type { Files } from '../../platform/files';

export interface MemoryFiles extends Files {
  /** Paths currently present. */
  paths(): string[];
  /** Every path `remove` was asked to delete, in order, whether or not it succeeded. */
  removeCalls(): string[];
  /** Makes `remove` reject for this path. */
  failRemoveFor(path: string): void;
}

/** An in-memory `Files` for tests. */
export function createMemoryFiles(initial: Record<string, Uint8Array> = {}): MemoryFiles {
  const store = new Map<string, Uint8Array>(Object.entries(initial));
  const removed: string[] = [];
  const failing = new Set<string>();
  return {
    write: (path, data) => {
      store.set(path, data);
      return Promise.resolve(`file:///${path}`);
    },
    read: (path) => {
      const data = store.get(path);
      return data ? Promise.resolve(data) : Promise.reject(new Error('File does not exist'));
    },
    remove: (path) => {
      removed.push(path);
      if (failing.has(path)) return Promise.reject(new Error('Unable to delete file'));
      if (!store.delete(path)) return Promise.reject(new Error('File does not exist'));
      return Promise.resolve();
    },
    displayUrl: (path) => Promise.resolve(`https://localhost/_capacitor_file_/${path}`),
    writeCacheChunks: (path) => Promise.resolve(`file:///cache/${path}`),
    removeCache: () => Promise.resolve(),
    paths: () => [...store.keys()],
    removeCalls: () => [...removed],
    failRemoveFor: (path) => {
      failing.add(path);
    },
  };
}
