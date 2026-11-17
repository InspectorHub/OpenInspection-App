/**
 * Disk and path checks for the desktop export. The package's own volume naming
 * rules come from `@inspectorhub/data-package` so the client cannot disagree
 * with the format about what a legal volume file is. A volume name is a leaf
 * file name only — it is checked against the package parser before it is ever
 * joined to the export directory, so a hostiles name cannot escape that dir.
 */
import { join, resolve } from 'node:path';
import { parseVolumeName, ROOT_VOLUME_NAME, ZIP_MAX_BYTES } from '@inspectorhub/data-package';

/** Client profile volume cap: 1 GiB, deliberately below the ZIP64-free ceiling. */
export const CLIENT_VOLUME_BYTES = 1024 * 1024 * 1024;
// Defensive: a future bump of the client cap must not cross the format's ZIP ceiling.
if (CLIENT_VOLUME_BYTES >= ZIP_MAX_BYTES) throw new Error('client volume cap exceeds ZIP limit');

/** The dedicated directory, under userData, where package volumes and resume state live. */
export function dataPackageDir(userData: string): string {
  return resolve(join(userData, 'data-package'));
}

/** True only for the root package or a numbered media volume the format recognises. */
export function isVolumeName(name: string): boolean {
  return parseVolumeName(name) !== null;
}

/**
 * Joins an accepted volume name to the export directory. Anything the format
 * does not recognise as a volume is refused, so `../`, separators, absolute
 * paths and look-alike names never become a file path.
 */
export function resolveVolumePath(directory: string, name: string): string {
  if (!isVolumeName(name)) throw new Error('invalid-volume-name');
  return resolve(join(directory, name));
}

/** Re-exported for callers that name the root volume explicitly. */
export { ROOT_VOLUME_NAME };

export interface StatFsLike {
  statfs(path: string): Promise<{ bavail: number; bsize: number }>;
}

export type FreeSpace =
  | { kind: 'enough' }
  | { kind: 'insufficient'; availableBytes: number; requiredBytes: number }
  | { kind: 'unknown' };

/**
 * The raw available byte count at `path`, or null when statfs is unavailable
 * or nonsensical. Kept distinct from `checkFreeSpace` so a caller can display
 * free space without picking an arbitrary requirement.
 */
export async function freeSpaceBytes(fs: StatFsLike, path: string): Promise<number | null> {
  try {
    const { bavail, bsize } = await fs.statfs(path);
    if (!Number.isSafeInteger(bavail) || !Number.isSafeInteger(bsize) || bavail < 0 || bsize <= 0) return null;
    const bytes = bavail * bsize;
    return Number.isSafeInteger(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Checks that `requiredBytes` fit at `path`. `statfs` may be unavailable on a
 * platform; that is `unknown`, never `enough`, so a caller can choose to be
 * conservative rather than start an export that will fail midway.
 */
export async function checkFreeSpace(fs: StatFsLike, path: string, requiredBytes: number): Promise<FreeSpace> {
  try {
    const { bavail, bsize } = await fs.statfs(path);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bavail < 0 || bsize <= 0) return { kind: 'unknown' };
    const availableBytes = bavail * bsize;
    return availableBytes >= requiredBytes
      ? { kind: 'enough' }
      : { kind: 'insufficient', availableBytes, requiredBytes };
  } catch {
    return { kind: 'unknown' };
  }
}
