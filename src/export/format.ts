/**
 * The names and shapes of the offline package (`openinspection-offline-package`, version 1). The engine refuses a whole package
 * for one entry name it does not know, so the names live in one place and nothing else in the app spells them.
 */

export const PACKAGE_FORMAT = 'openinspection-offline-package';
export const PACKAGE_VERSION = 1;

export const MANIFEST_ENTRY = 'manifest.json';
export const OUTBOX_ENTRY = 'outbox.json';
export const MEDIA_INDEX_ENTRY = 'media/index.json';

/** The photo types a package can carry, with the extension each is stored under. */
export const PHOTO_EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic' } as const;
export type PackagePhotoType = keyof typeof PHOTO_EXTENSIONS;

export function isPackagePhotoType(value: string): value is PackagePhotoType {
  return Object.hasOwn(PHOTO_EXTENSIONS, value);
}

/** An identifier the format accepts: no separator, dot segment or whitespace can reach an entry name. */
export const PACKAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** An idempotency key travels in a header, so the format limits it to header-safe characters. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Stands in for the report id of an inspection whose report the device never learned; the engine only compares it for inspections it already has. */
export const UNKNOWN_REPORT_ID = 'unassigned';
/** Stands in for a device id that was never stored. The engine records it and decides nothing from it. */
export const UNKNOWN_DEVICE_ID = 'unknown-device';

export const yjsEntryName = (inspectionId: string): string => `yjs/${inspectionId}.bin`;
export const mediaEntryName = (pendingId: string, contentType: PackagePhotoType): string => `media/${pendingId}.${PHOTO_EXTENSIONS[contentType]}`;

export interface OutboxJsonEntry {
  idempotencyKey: string;
  op: 'inspection.create' | 'inspection.update' | 'inspection.complete';
  payload: Record<string, unknown> & { id: string };
}

export interface MediaIndexRow {
  pendingId: string;
  inspectionId: string;
  contentType: PackagePhotoType;
}

/**
 * The only names this app ever writes into the cache directory for an export, and the only names its sweep removes. The name
 * holds nothing about a customer: a prefix, the moment the export began, and the extension.
 */
export const EXPORT_FILE_PREFIX = 'inspectorhub-export-';
export const EXPORT_FILE_PATTERN = /^inspectorhub-export-(\d{10,16})\.zip$/;

export function exportFileName(nowMs: number): string {
  return `${EXPORT_FILE_PREFIX}${String(Math.floor(nowMs))}.zip`;
}
