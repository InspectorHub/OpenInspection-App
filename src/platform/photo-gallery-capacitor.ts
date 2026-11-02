import { Capacitor } from '@capacitor/core';
import { Media } from '@capacitor-community/media';
import { bytesToBase64 } from './base64';
import type { GallerySaveResult, PhotoGallery } from './photo-gallery';

/** The album the copies go into on Android. See `createCapacitorGallery` for where that is on the phone. */
export const GALLERY_ALBUM_NAME = 'InspectorHub';

/** The part of the @capacitor-community/media plugin the app uses. */
export interface MediaPluginLike {
  savePhoto(options: { path: string; albumIdentifier?: string; fileName?: string }): Promise<unknown>;
  createAlbum(options: { name: string }): Promise<void>;
  getAlbums(): Promise<{ albums: Array<{ identifier: string; name: string }> }>;
  getAlbumsPath(): Promise<{ path: string }>;
}

export interface CapacitorGalleryOptions {
  platform: 'android' | 'ios';
  media: MediaPluginLike;
}

/**
 * How a refusal of access to the photo library looks when the plugin rejects. Read from its source (9.1.0):
 *  - Android, with the plugin's gallery mode on (this app does not turn it on, so this does not happen today): code `accessDenied`.
 *  - iOS: the message "Access to photos not allowed by user".
 * A broader match on "denied" or "permission" is NOT used: Android wraps a file-system error as "Error occurred:
 * java.lang.RuntimeException: ... (Permission denied)", which is a failed write, not something the person can allow in Settings.
 */
const REFUSED_CODE = 'accessDenied';
/** The plugin's message when the album folder it was told about is not there (any more). */
const ALBUM_GONE = /Album identifier does not exist/i;
const REFUSED_TEXT = /not allowed by user|user denied permission/i;

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  return typeof error === 'string' ? error : '';
}

function refused(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    if ((error as { code?: unknown }).code === REFUSED_CODE) return true;
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return REFUSED_TEXT.test(message);
  }
  return typeof error === 'string' && REFUSED_TEXT.test(error);
}

/** Without the extension, which the plugin adds on Android, and with nothing that is not a letter, digit, dash or underscore. */
export function albumFileName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * The phone's photo library through @capacitor-community/media. Saving is best effort and never throws.
 *
 * Android: into its own album "InspectorHub". WHERE that is, read from the plugin's source: its "albums path" is the app's own external
 * media folder (`getExternalMediaDirs()[0]`, /storage/emulated/0/Android/media/<package>), the album is a folder in it, and after copying
 * the file the plugin sends the (deprecated) media-scanner broadcast. It is NOT Pictures/InspectorHub.
 * Measured on a Huawei ALP-AL00, Android 10 (2026-11-02): the photo is in the system media index at once (bucket "InspectorHub") and the
 * phone's gallery lists it as the album "InspectorHub" (under "Other albums" in Huawei's gallery); a normal UNINSTALL of the app deletes the
 * folder and the copies with it (the index keeps stale rows for files that are gone). So on Android the copy outlives signing out and
 * clearing local data, NOT uninstalling the app. Other Android versions and makers are not measured.
 * No storage permission is requested for an album the app owns. The album is looked up by name AND by the albums path with a separator, so
 * another app's folder of the same name (or a sibling package whose name starts with ours) is not taken for ours. It is created on first
 * use; two photos saved at once share one lookup; the remembered album is forgotten after a failure.
 *
 * iOS: no album, so the photo goes to Recents and the system asks for the "add only" permission, not for access to the whole library.
 */
export function createCapacitorGallery(options: CapacitorGalleryOptions): PhotoGallery {
  const { platform, media } = options;
  let album: Promise<string> | undefined;

  async function find(): Promise<string | undefined> {
    const [{ albums }, { path }] = await Promise.all([media.getAlbums(), media.getAlbumsPath()]);
    const root = path.endsWith('/') ? path : `${path}/`;
    return albums.find((candidate) => candidate.name === GALLERY_ALBUM_NAME && candidate.identifier.startsWith(root))?.identifier;
  }

  async function resolveAlbum(): Promise<string> {
    const existing = await find();
    if (existing !== undefined) return existing;
    try {
      await media.createAlbum({ name: GALLERY_ALBUM_NAME });
    } catch (error) {
      // Created in the meantime (by the person, or by another save): look again before giving up.
      const created = await find();
      if (created !== undefined) return created;
      throw error;
    }
    const created = await find();
    if (created === undefined) throw new Error('the album was created but not found');
    return created;
  }

  /** One lookup shared by every save that starts before it has finished. A failed lookup is not remembered. */
  function androidAlbum(): Promise<string> {
    if (album === undefined) {
      const pending = resolveAlbum();
      album = pending;
      pending.catch(() => {
        if (album === pending) album = undefined;
      });
    }
    return album;
  }

  /** One try: the album, then the photo. */
  async function attempt(dataUrl: string, name: string): Promise<void> {
    if (platform === 'android') {
      await media.savePhoto({ path: dataUrl, albumIdentifier: await androidAlbum(), fileName: albumFileName(name) });
    } else {
      await media.savePhoto({ path: dataUrl });
    }
  }

  return {
    available: () => true,
    async save(blob, info): Promise<GallerySaveResult> {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const dataUrl = `data:${blob.type || 'image/jpeg'};base64,${bytesToBase64(bytes)}`;
        try {
          await attempt(dataUrl, info.name);
        } catch (error) {
          // Seen on a phone (Huawei, Android 10): the system's media index still listed the album after its folder was deleted, so the
          // plugin handed back that folder's path and then refused it: "Album identifier does not exist". The folder is made again and
          // the photo is tried once more. Any other failure, or a second one, is the answer.
          if (platform !== 'android' || !ALBUM_GONE.test(messageOf(error))) throw error;
          album = undefined;
          await media.createAlbum({ name: GALLERY_ALBUM_NAME }).catch(() => undefined);
          await attempt(dataUrl, info.name);
        }
        return 'saved';
      } catch (error) {
        // The remembered album may have been deleted by the person since: look it up again next time.
        album = undefined;
        return refused(error) ? 'denied' : 'failed';
      }
    },
  };
}

/** The real plugin, on a phone. In a browser (development) nothing can be saved, and nothing offers to. */
export function createRealGallery(): PhotoGallery | null {
  if (!Capacitor.isNativePlatform()) return null;
  const platform = Capacitor.getPlatform();
  if (platform !== 'android' && platform !== 'ios') return null;
  return createCapacitorGallery({ platform, media: Media });
}
