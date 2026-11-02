import type { DesktopBridge } from '../../electron/shared/ipc-contract';
import type { Files } from '../platform/files';

export function createDesktopFiles(bridge: Pick<DesktopBridge, 'files'>): Files {
  const writeChunks = async (area: 'media' | 'cache', path: string, chunks: AsyncIterable<Uint8Array>): Promise<string> => {
    const { handle } = await bridge.files.stream.open(area, path);
    try {
      for await (const chunk of chunks) await bridge.files.stream.append(handle, chunk);
      return await bridge.files.stream.finish(handle, 'commit');
    } catch (error) {
      await bridge.files.stream.finish(handle, 'abort').catch(() => undefined);
      throw error;
    }
  };
  return {
    write: (path, data) => bridge.files.write(path, data),
    writeStream: (path, chunks) => writeChunks('media', path, chunks),
    size: (path) => bridge.files.size(path),
    read: (path) => bridge.files.read(path),
    remove: (path) => bridge.files.remove(path),
    displayUrl: (path) => bridge.files.displayUrl(path),
    fileUri: (path) => bridge.files.fileUri(path),
    exists: (path) => bridge.files.exists(path),
    list: (path) => bridge.files.list(path),
    writeCacheChunks: (path, chunks) => writeChunks('cache', path, chunks),
    removeCache: (path) => bridge.files.removeCache(path),
    listCache: () => bridge.files.listCache(),
  };
}
