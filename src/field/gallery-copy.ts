import type { PendingMediaRecord } from '@inspectorhub/field-ui';
import type { KeyValue } from '../platform/kv';
import type { GallerySaveResult, PhotoGallery } from '../platform/photo-gallery';

type Photo = Extract<PendingMediaRecord, { kind: 'photo' }>;

/** The device setting behind "Save photos I take to my gallery". Off until the person turns it on. */
export interface GallerySetting {
  get(): Promise<boolean>;
  set(value: boolean): Promise<void>;
}

export const GALLERY_SETTING_KEY = 'save_photos_to_gallery';

export function createGallerySetting(kv: KeyValue): GallerySetting {
  return {
    get: async () => (await kv.get(GALLERY_SETTING_KEY).catch(() => null)) === '1',
    set: (value) => kv.set(GALLERY_SETTING_KEY, value ? '1' : '0'),
  };
}

/** Where the editor says a photo came from. Only photos taken in the app are copied: a photo picked from the library is already there. */
const TAKEN_IN_APP = new Set(['camera', 'burst']);

/**
 * The source the editor attached to a photo, or null. The editor package adds `source` to the photo's meta from a later version on;
 * before that it is absent and nothing is copied (fewer copies, never a duplicate of a library photo).
 */
export function photoSource(rec: Photo): string | null {
  const source = (rec.meta as { source?: unknown }).source;
  return typeof source === 'string' ? source : null;
}

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' };

/** A file name with the time and a piece of the pending id: no client, address or inspection detail. */
export function galleryFileName(rec: Photo): string {
  const when = new Date(rec.createdAt);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${String(when.getUTCFullYear())}${pad(when.getUTCMonth() + 1)}${pad(when.getUTCDate())}-${pad(when.getUTCHours())}${pad(when.getUTCMinutes())}${pad(when.getUTCSeconds())}`;
  const extension = EXTENSION[rec.blob.type.split(';')[0]?.trim().toLowerCase() ?? ''] ?? 'jpg';
  return `InspectorHub-${stamp}-${rec.pendingId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}.${extension}`;
}

export interface GalleryCopierDeps {
  setting: Pick<GallerySetting, 'get'>;
  gallery: PhotoGallery;
  /** What happened, for the diagnostics. 'skipped' is a photo that is not copied (setting off, not taken in the app, no gallery). Never receives a name or a path. */
  onResult?(result: GallerySaveResult | 'skipped'): void;
}

/** Copies a photo that was just taken to the gallery when the setting is on. Never throws and never delays or changes an upload. */
export function createGalleryCopier(deps: GalleryCopierDeps): (rec: Photo) => Promise<void> {
  return async (rec) => {
    try {
      const source = photoSource(rec);
      if (!deps.gallery.available() || source === null || !TAKEN_IN_APP.has(source) || !(await deps.setting.get())) {
        deps.onResult?.('skipped');
        return;
      }
      deps.onResult?.(await deps.gallery.save(rec.blob, { name: galleryFileName(rec), createdAt: rec.createdAt }));
    } catch {
      try {
        deps.onResult?.('failed');
      } catch {
        // A reporter that fails changes nothing.
      }
    }
  };
}
