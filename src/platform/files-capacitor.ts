import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { base64ToBytes, bytesToBase64 } from './base64';
import type { FileEntry, Files } from './files';
import { assertSafeRelativePath, isNotFoundError } from './files-path';

/** The subset of the Filesystem plugin the adapter uses. */
export interface FilesystemLike {
  writeFile(options: { path: string; data: string; directory: Directory; recursive: boolean }): Promise<{ uri: string }>;
  appendFile(options: { path: string; data: string; directory: Directory }): Promise<void>;
  readFile(options: { path: string; directory: Directory }): Promise<{ data: string | Blob }>;
  deleteFile(options: { path: string; directory: Directory }): Promise<void>;
  getUri(options: { path: string; directory: Directory }): Promise<{ uri: string }>;
  stat(options: { path: string; directory: Directory }): Promise<{ size?: number }>;
  readdir(options: { path: string; directory: Directory }): Promise<{ files: { name: string; mtime?: number }[] }>;
}

export interface FilesDeps {
  fs: FilesystemLike;
  convertFileSrc: (uri: string) => string;
}

/** Bytes per plugin call; each slice is encoded to base64 independently. */
export const WRITE_SLICE_BYTES = 1024 * 1024;

export function createFiles(deps: FilesDeps): Files {
  const directory = Directory.LibraryNoCloud;
  const cacheDirectory = Directory.Cache;
  const { fs } = deps;

  async function write(path: string, data: Uint8Array): Promise<string> {
    return writeChunks(directory, path, slices(data));
  }

  async function writeStream(path: string, chunks: AsyncIterable<Uint8Array>): Promise<string> {
    return writeChunks(directory, path, chunks);
  }

  async function writeCacheChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<string> {
    return writeChunks(cacheDirectory, path, chunks);
  }

  async function writeChunks(
    target: Directory,
    path: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<string> {
    assertSafeRelativePath(path);
    let uri: string | null = null;
    try {
      for await (const chunk of chunks) {
        const data = bytesToBase64(chunk);
        if (uri === null) {
          uri = (await fs.writeFile({ path, data, directory: target, recursive: true })).uri;
        } else {
          await fs.appendFile({ path, data, directory: target });
        }
      }
      uri ??= (await fs.writeFile({ path, data: '', directory: target, recursive: true })).uri;
      return uri;
    } catch (err) {
      // Only a file this call began writing is removed; a pre-existing file survives
      // a stream that fails before its first chunk.
      if (uri !== null) await fs.deleteFile({ path, directory: target }).catch(() => undefined);
      throw err;
    }
  }

  async function readEntries(path: string, target: Directory): Promise<FileEntry[]> {
    try {
      const { files } = await fs.readdir({ path, directory: target });
      return files.map((entry) => ({ name: entry.name, mtimeMs: typeof entry.mtime === 'number' && Number.isFinite(entry.mtime) ? entry.mtime : null }));
    } catch (error) {
      if (isNotFoundError(error)) return [];
      throw error;
    }
  }

  return {
    write,
    writeStream,
    writeCacheChunks,
    size: async (path) => {
      assertSafeRelativePath(path);
      const { size } = await fs.stat({ path, directory });
      return typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null;
    },
    read: async (path) => {
      assertSafeRelativePath(path);
      const { data } = await fs.readFile({ path, directory });
      return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer());
    },
    removeCache: async (path) => {
      assertSafeRelativePath(path);
      await fs.deleteFile({ path, directory: cacheDirectory });
    },
    remove: async (path) => {
      assertSafeRelativePath(path);
      await fs.deleteFile({ path, directory });
    },
    displayUrl: async (path) => {
      assertSafeRelativePath(path);
      const { uri } = await fs.getUri({ path, directory });
      return deps.convertFileSrc(uri);
    },
    fileUri: async (path) => {
      assertSafeRelativePath(path);
      const { uri } = await fs.getUri({ path, directory });
      return uri;
    },
    exists: async (path) => {
      assertSafeRelativePath(path);
      try {
        await fs.stat({ path, directory });
        return true;
      } catch (error) {
        if (isNotFoundError(error)) return false;
        throw error;
      }
    },
    list: async (directoryPath) => {
      assertSafeRelativePath(directoryPath);
      return readEntries(directoryPath, directory);
    },
    listCache: () => readEntries('', cacheDirectory),
  };
}

/** Thin real-plugin wiring. */
export function createRealFiles(): Files {
  return createFiles({ fs: Filesystem, convertFileSrc: (uri) => Capacitor.convertFileSrc(uri) });
}

async function* slices(data: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += WRITE_SLICE_BYTES) {
    yield data.subarray(i, i + WRITE_SLICE_BYTES);
  }
}
