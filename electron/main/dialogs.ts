import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IpcError } from '../shared/ipc-contract.ts';

export interface FsLike {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean }>;
  copyFile(source: string, destination: string): Promise<void>;
}

export interface DialogsHostDeps {
  dialog: { showSaveDialog(options: unknown): Promise<{ canceled: boolean; filePath?: string }> };
  fs: FsLike;
  cacheRoot: string;
  downloadsDir: string;
  showItemInFolder(path: string): void;
}

const EXPORT_NAME = /^[A-Za-z0-9._ -]{1,100}\.zip$/;

function invalidArgument(): never {
  throw new IpcError('invalid-argument');
}

function fixedSaveError(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  if (code === 'ENOSPC') throw new IpcError('disk-full');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new IpcError('unavailable');
  throw new IpcError('internal');
}

function sourcePathFromUri(fileUri: string): string {
  try {
    const url = new URL(fileUri);
    if (url.protocol !== 'file:' || url.hostname !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return invalidArgument();
    const path = fileURLToPath(url);
    if (path.startsWith('\\\\') || path.startsWith('//')) return invalidArgument();
    return path;
  } catch {
    return invalidArgument();
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function createDialogsHost(deps: DialogsHostDeps): { saveExport(fileUri: string, suggestedName: string): Promise<'saved' | 'cancelled'> } {
  return {
    async saveExport(fileUri, suggestedName) {
      if (!EXPORT_NAME.test(suggestedName)) return invalidArgument();
      const requestedPath = sourcePathFromUri(fileUri);
      if (!EXPORT_NAME.test(requestedPath.split(/[\\/]/).at(-1) ?? '')) return invalidArgument();

      let cacheRoot: string;
      let sourcePath: string;
      let sourceIsFile: boolean;
      try {
        [cacheRoot, sourcePath] = await Promise.all([deps.fs.realpath(deps.cacheRoot), deps.fs.realpath(requestedPath)]);
        sourceIsFile = (await deps.fs.stat(sourcePath)).isFile();
      } catch (error) {
        if (error instanceof IpcError) throw error;
        return fixedSaveError(error);
      }
      if (!inside(cacheRoot, sourcePath) || !sourceIsFile || !EXPORT_NAME.test(sourcePath.split(/[\\/]/).at(-1) ?? '')) return invalidArgument();

      let selection: { canceled: boolean; filePath?: string };
      try {
        selection = await deps.dialog.showSaveDialog({
          defaultPath: join(deps.downloadsDir, suggestedName),
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        });
      } catch {
        throw new IpcError('unavailable');
      }
      if (selection.canceled) return 'cancelled';
      if (typeof selection.filePath !== 'string' || selection.filePath.length === 0) throw new IpcError('unavailable');

      try {
        await deps.fs.copyFile(sourcePath, selection.filePath);
      } catch (error) {
        return fixedSaveError(error);
      }
      try {
        deps.showItemInFolder(selection.filePath);
      } catch {
        throw new IpcError('unavailable');
      }
      return 'saved';
    },
  };
}
