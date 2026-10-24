import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { base64ToBytes, bytesToBase64 } from './base64';

export interface Files {
  /** Writes `data` and returns the `file://` uri. */
  write(path: string, data: Uint8Array): Promise<string>;
  read(path: string): Promise<Uint8Array>;
  remove(path: string): Promise<void>;
  /** A webview-loadable url for the file (for `<img src>`). */
  displayUrl(path: string): Promise<string>;
  /** Streams chunks into one file without holding the whole payload in memory. */
  writeCacheChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<string>;
}

/** The subset of the Filesystem plugin the adapter uses. */
export interface FilesystemLike {
  writeFile(options: { path: string; data: string; directory: Directory; recursive: boolean }): Promise<{ uri: string }>;
  appendFile(options: { path: string; data: string; directory: Directory }): Promise<void>;
  readFile(options: { path: string; directory: Directory }): Promise<{ data: string | Blob }>;
  deleteFile(options: { path: string; directory: Directory }): Promise<void>;
  getUri(options: { path: string; directory: Directory }): Promise<{ uri: string }>;
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
  const { fs } = deps;

  async function write(path: string, data: Uint8Array): Promise<string> {
    return writeCacheChunks(path, slices(data));
  }

  async function writeCacheChunks(path: string, chunks: AsyncIterable<Uint8Array>): Promise<string> {
    assertSafeRelativePath(path);
    let uri: string | null = null;
    try {
      for await (const chunk of chunks) {
        const data = bytesToBase64(chunk);
        if (uri === null) {
          uri = (await fs.writeFile({ path, data, directory, recursive: true })).uri;
        } else {
          await fs.appendFile({ path, data, directory });
        }
      }
      uri ??= (await fs.writeFile({ path, data: '', directory, recursive: true })).uri;
      return uri;
    } catch (err) {
      await fs.deleteFile({ path, directory }).catch(() => undefined);
      throw err;
    }
  }

  return {
    write,
    writeCacheChunks,
    read: async (path) => {
      assertSafeRelativePath(path);
      const { data } = await fs.readFile({ path, directory });
      return typeof data === 'string' ? base64ToBytes(data) : new Uint8Array(await data.arrayBuffer());
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
