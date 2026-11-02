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
  /**
   * The entries directly inside the OS cache directory (its root). A directory that is not there lists as
   * empty; any other failure rejects. Used to find temp files other components leave behind.
   */
  listCache(): Promise<FileEntry[]>;
}

export interface FileEntry {
  name: string;
  /** Last modification, milliseconds since the epoch; null when the platform did not say. */
  mtimeMs: number | null;
}
