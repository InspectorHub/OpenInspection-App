import { IMPORT_LIMIT_CEILINGS, readPackageSummary, type PackageSummary } from '@inspectorhub/offline-package';

/**
 * Getting a package into memory from a file the person chose.
 *
 * The picker is a plain `<input type="file">`: no plugin, no extra permission. `accept` is a hint to the system picker and not a
 * check, so everything is verified here. The size is judged from the file's own `size` BEFORE a byte is read, because reading
 * a file that can never be imported would still cost its whole size in memory on a phone.
 */

/** The `accept` of the file input: the extension, and the two media types systems use for a zip. */
export const ACCEPT_PACKAGE_FILES = '.zip,application/zip,application/x-zip-compressed';

/** The part of a `File` this module uses, so a test can pass a stand-in that records what was read. */
export interface PickedFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type PackageRead = { kind: 'ready'; fileName: string; bytes: Uint8Array; summary: PackageSummary } | { kind: 'refused'; message: string };

const MIB = 1024 * 1024;

/** "24 MiB", "1.5 MiB", "300 KiB": a size a person can compare with the limit in the message. */
export function formatSize(bytes: number): string {
  if (bytes >= MIB) return `${String(Math.round((bytes / MIB) * 10) / 10)} MiB`;
  return `${String(Math.max(1, Math.round(bytes / 1024)))} KiB`;
}

export const FILE_EMPTY = 'That file is empty. Choose the package the app exported.';
export const FILE_NOT_A_PACKAGE = 'This file is not a valid InspectorHub package, so nothing was sent. Choose the file exactly as the app exported it.';
export const FILE_UNREADABLE = 'That file could not be read. Check that it is still on this device, then choose it again.';

export function fileTooLarge(actual: number, max: number): string {
  return `That file is ${formatSize(actual)}, which is over the ${formatSize(max)} limit, so it was not read or sent. Export the inspections again in smaller groups.`;
}

export async function readPackageFile(file: PickedFile): Promise<PackageRead> {
  const max = IMPORT_LIMIT_CEILINGS.compressedBytes;
  if (file.size === 0) return { kind: 'refused', message: FILE_EMPTY };
  if (file.size > max) return { kind: 'refused', message: fileTooLarge(file.size, max) };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    // The reason (a permission, a content address) is the system's own text: it is not shown.
    return { kind: 'refused', message: FILE_UNREADABLE };
  }
  try {
    return { kind: 'ready', fileName: file.name, bytes, summary: readPackageSummary(bytes) };
  } catch {
    return { kind: 'refused', message: FILE_NOT_A_PACKAGE };
  }
}
