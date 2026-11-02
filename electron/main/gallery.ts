import { join } from 'node:path';
import { GALLERY_FILE_NAME, IpcError } from '../shared/ipc-contract.ts';

/** The folder under the person's Pictures folder that copies go into. */
export const GALLERY_FOLDER = 'InspectorHub';

export interface GalleryFsLike {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  /** Creates the file and writes it, or fails with EEXIST rather than replace one: flag 'wx'. */
  writeNew(path: string, data: Uint8Array): Promise<void>;
  /** The size of an existing file in bytes. */
  size(path: string): Promise<number>;
  /** Removes a file. Used only on the file this very call was writing when the write failed. */
  remove(path: string): Promise<void>;
}

export interface GalleryHostDeps {
  fs: GalleryFsLike;
  /** The person's Pictures folder, as the system names it. */
  picturesDir: string;
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';
}

/** A write or folder failure as one of the closed codes the renderer may see: no text, no path. */
function closed(error: unknown): IpcError {
  const code = codeOf(error);
  if (code === 'ENOSPC') return new IpcError('disk-full');
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new IpcError('unavailable');
  return new IpcError('internal');
}

/**
 * Puts a copy of a photo into the InspectorHub folder of the person's Pictures folder (Windows: Pictures\InspectorHub; macOS: ~/Pictures/InspectorHub;
 * `app.getPath('pictures')` names it on each, and nothing here is specific to one system: the folder is joined, never typed with a separator).
 * On macOS, a build distributed through the Mac App Store runs in the sandbox and needs the com.apple.security.assets.pictures.read-write
 * entitlement for this; a build signed for direct distribution does not. The name was checked at the boundary and is checked again here: the folder is fixed
 * and the name has no separator.
 *
 * - An existing file is never replaced. A second save of the same photo finds the same bytes (the same size) and counts as saved; a file of
 *   that name with another size is NOT the same copy (a different photo, or a half-written one) and is reported as a failure, never as saved.
 * - The only delete in this file: when a write fails after the file was created, the half-written file this call made is removed, so a
 *   truncated photo is not left in the person's library and later taken for a copy. It is never a file that was there before (that case is
 *   EEXIST and stops before writing). Nothing else is ever removed: the app never deletes what it put in the person's library.
 */
export function createGalleryHost(deps: GalleryHostDeps): { save(name: string, data: Uint8Array): Promise<'saved'> } {
  return {
    async save(name, data) {
      if (!GALLERY_FILE_NAME.test(name)) throw new IpcError('invalid-argument');
      const folder = join(deps.picturesDir, GALLERY_FOLDER);
      try {
        // EEXIST here means the folder's name is taken by a FILE: that is a failure, not "already saved".
        await deps.fs.mkdir(folder, { recursive: true });
      } catch (error) {
        throw closed(error);
      }
      const target = join(folder, name);
      try {
        await deps.fs.writeNew(target, data);
      } catch (error) {
        if (codeOf(error) === 'EEXIST') {
          let existing: number;
          try {
            existing = await deps.fs.size(target);
          } catch (sizeError) {
            throw closed(sizeError);
          }
          if (existing === data.byteLength) return 'saved';
          throw new IpcError('internal');
        }
        // The file may have been created before the write failed: take away what this call made, if it can.
        await deps.fs.remove(target).catch(() => undefined);
        throw closed(error);
      }
      return 'saved';
    },
  };
}
