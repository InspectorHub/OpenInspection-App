import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { base64ToBytes, bytesToBase64 } from './base64';

export interface Files {
  /** Writes `data` and returns the `file://` uri. */
  write(path: string, data: Uint8Array): Promise<string>;
  /**
   * Like `write`, for content that must not be held whole in memory (a video clip): the chunks are appended one
   * at a time. A file this call began writing is removed if the stream fails after its first chunk; a file that
   * was already there survives a stream that fails before it.
   */
  writeStream(path: string, chunks: AsyncIterable<Uint8Array>): Promise<string>;
  /** The size of the file in bytes, or null when the platform did not report one. Rejects when it cannot be read, a missing file included. */
  size(path: string): Promise<number | null>;
  read(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  /** A webview-loadable url for the file (for `<img src>`). */
  displayUrl(path: string): Promise<string>;
  /** The `file://` uri of the file, for native plugins that read it themselves (the background uploader). */
  fileUri(path: string): Promise<string>;
  /**
   * True when the file is there; false ONLY when the platform confirmed it is not. Any other failure (permission,
   * I/O error, a plugin that cannot answer) rejects, so a caller never mistakes "could not check" for "gone".
   */
  exists(path: string): Promise<boolean>;
  /** The entries directly inside a directory of the app's storage. A directory that is not there lists as empty. */
  list(directoryPath: string): Promise<FileEntry[]>;
  /**
   * Streams chunks into one file in the OS cache directory, without holding the
   * whole payload in memory. Intended for transient files such as an export
   * archive handed to the share sheet, which can contain unencrypted personal
   * data: the caller must delete it with `removeCache` once sharing is done.
   * If the stream fails after the first chunk, the partly written file is removed
   * (an existing file at the same path is overwritten by then); if it fails
   * before the first chunk, nothing is touched.
   */
  writeCacheChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<string>;
  /** Deletes a file previously created with `writeCacheChunks`. */
  removeCache(path: string): Promise<void>;
}

export interface FileEntry {
  name: string;
  /** Last modification, milliseconds since the epoch; null when the platform did not say. */
  mtimeMs: number | null;
}

/** The plugin's error code for a missing file (Android and iOS share the `OS-PLUG-FILE-` family). */
const NOT_FOUND_CODE = 'OS-PLUG-FILE-0008';

/** True only for the plugin's own "does not exist" answer, by its code or by its fixed message text. */
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === NOT_FOUND_CODE) return true;
  return typeof message === 'string' && /does not exist/i.test(message);
}

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

/**
 * Paths are relative to the app's no-backup directory. Absolute paths, drive or
 * scheme prefixes, backslashes and `.`/`..` segments are rejected so a caller
 * can never address anything outside it.
 */
export function assertSafeRelativePath(path: string): void {
  if (path.length === 0) throw new Error('File path must not be empty');
  for (const segment of path.split('/')) {
    const bad =
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('\\') ||
      segment.includes(':') ||
      /[\u0000-\u001f]/.test(segment);
    if (bad) throw new Error(`Unsafe file path: ${JSON.stringify(path)}`);
  }
}

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
      try {
        const { files } = await fs.readdir({ path: directoryPath, directory });
        return files.map((entry) => ({ name: entry.name, mtimeMs: typeof entry.mtime === 'number' && Number.isFinite(entry.mtime) ? entry.mtime : null }));
      } catch (error) {
        if (isNotFoundError(error)) return [];
        throw error;
      }
    },
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
