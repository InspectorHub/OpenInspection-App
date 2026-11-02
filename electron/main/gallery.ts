import { join } from 'node:path';
import { GALLERY_FILE_NAME, IpcError } from '../shared/ipc-contract.ts';

/** The folder under the person's Pictures folder that copies go into. */
export const GALLERY_FOLDER = 'InspectorHub';

export interface GalleryFsLike {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  /** Fails with EEXIST rather than replace a file: flag 'wx'. */
  writeNew(path: string, data: Uint8Array): Promise<void>;
}

export interface GalleryHostDeps {
  fs: GalleryFsLike;
  /** The person's Pictures folder, as the system names it. */
  picturesDir: string;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
}

/**
 * Puts a copy of a photo into Pictures\InspectorHub. The name was checked at the boundary and is checked again here: the folder is fixed,
 * the name has no separator, and an existing file is never replaced or touched (a second save of the same photo is the same copy, so it
 * counts as saved). Nothing in this file deletes a file: the app never removes what it put in the person's library.
 */
export function createGalleryHost(deps: GalleryHostDeps): { save(name: string, data: Uint8Array): Promise<'saved'> } {
  return {
    async save(name, data) {
      if (!GALLERY_FILE_NAME.test(name)) throw new IpcError('invalid-argument');
      const folder = join(deps.picturesDir, GALLERY_FOLDER);
      try {
        await deps.fs.mkdir(folder, { recursive: true });
        await deps.fs.writeNew(join(folder, name), data);
      } catch (error) {
        const code = codeOf(error);
        if (code === 'EEXIST') return 'saved';
        if (code === 'ENOSPC') throw new IpcError('disk-full');
        if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') throw new IpcError('unavailable');
        throw new IpcError('internal');
      }
      return 'saved';
    },
  };
}
