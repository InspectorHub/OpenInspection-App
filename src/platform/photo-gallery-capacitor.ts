import { Capacitor } from '@capacitor/core';
import { Media } from '@capacitor-community/media';
import { bytesToBase64 } from './base64';
import type { GallerySaveResult, PhotoGallery } from './photo-gallery';

/** The album the copies go into on Android (a folder under Pictures). iOS gets no album, see below. */
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
 * Words the plugin and the two systems use when the person (or the system) refused access to the photo library. The plugin rejects with a
 * message, not a code, so this is a match on text: a refusal it does not recognise is reported as 'failed', which is the safe side (no
 * "go and allow it" hint for something that is not a permission).
 */
const REFUSED = /permission|denied|not authori[sz]ed|authori[sz]ation|restricted|access to (?:the )?(?:photo|media)/i;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) return String((error as { message: unknown }).message);
  return String(error);
}

/** Without the extension, which the plugin adds on Android, and with nothing that is not a letter, digit, dash or underscore. */
export function albumFileName(name: string): string {
  return name.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9_-]/g, '');
}

/**
 * The phone's photo library through @capacitor-community/media. Saving is best effort and never throws.
 *
 * Android: into its own album "InspectorHub" (created on first use, found again by name AND by the path the plugin reports for albums, so
 * another app's album of the same name is not taken for ours). The plugin asks for no storage permission for an album the app owns.
 * iOS: no album, so the photo goes to Recents and the system asks for the "add only" permission, not for access to the whole library.
 */
export function createCapacitorGallery(options: CapacitorGalleryOptions): PhotoGallery {
  const { platform, media } = options;
  let albumIdentifier: string | undefined;

  async function androidAlbum(): Promise<string> {
    if (albumIdentifier !== undefined) return albumIdentifier;
    const find = async (): Promise<string | undefined> => {
      const [{ albums }, { path }] = await Promise.all([media.getAlbums(), media.getAlbumsPath()]);
      return albums.find((album) => album.name === GALLERY_ALBUM_NAME && album.identifier.startsWith(path))?.identifier;
    };
    let found = await find();
    if (found === undefined) {
      await media.createAlbum({ name: GALLERY_ALBUM_NAME });
      found = await find();
    }
    if (found === undefined) throw new Error('the album was created but not found');
    albumIdentifier = found;
    return found;
  }

  return {
    available: () => true,
    async save(blob, info): Promise<GallerySaveResult> {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const path = `data:${blob.type || 'image/jpeg'};base64,${bytesToBase64(bytes)}`;
        if (platform === 'android') {
          await media.savePhoto({ path, albumIdentifier: await androidAlbum(), fileName: albumFileName(info.name) });
        } else {
          await media.savePhoto({ path });
        }
        return 'saved';
      } catch (error) {
        // A cached album can have been deleted by the person since: look it up again next time.
        albumIdentifier = undefined;
        return REFUSED.test(messageOf(error)) ? 'denied' : 'failed';
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
